import { createLineElement, applyLineStyle, updateLinePosition, arrowTrimLength } from "../lib/RelationshipLine.js";

// 확대/축소해도 선 굵기·클릭 범위가 화면에서 일정하게 보이게(화면 px 기준, 가계도 TreeRenderer와 같은
// 방식). 덱 관계선은 덱 사이 넓은 공간을 가로지르니 가계도(1.5px)보다 굵게 — 화살촉도 선 굵기에 비례해 커진다.
const LINE_TARGET_SCREEN_PX = 3;
const LINE_SELECTED_TARGET_SCREEN_PX = 4.5;
const LINE_HIT_TARGET_SCREEN_PX = 18;
const EDGE_GAP = 6; // 덱 테두리에서 이만큼 띄워서 선을 끝낸다(화살촉이 덱에 안 묻히게)
const PARALLEL_SPACING = 18; // 같은 두 덱 사이에 관계선이 여럿이면 이 간격으로 나란히 벌린다

/**
 * 덱끼리 잇는 관계선(DeckModel.relations)을 SVG로 그린다. 선 모양·화살촉·라벨은 가계도의
 * RelationshipLine.js를 그대로 쓰고, 여기서는 "덱 사각형 테두리에서 테두리까지" 끝점만 계산한다.
 * 덱 크기는 DeckRenderer가 DOM에서 잰 값(rects)을 쓴다 — 그래서 모델 리스너는 DeckRenderer보다
 * 나중에 등록돼야 한다(덱 DOM이 먼저 갱신된 뒤 선을 맞춤).
 */
export class RelationRenderer {
  constructor({ model, layerEl, camera, deckRenderer, onClick }) {
    this.model = model;
    this.layerEl = layerEl;
    this.camera = camera;
    this.deckRenderer = deckRenderer;
    this.onClick = onClick;
    this.lineEls = new Map(); // relId -> <g>
    this.selectedId = null;

    model.onChange((type, payload) => {
      if (type === "reset") return this.renderAll();
      if (type === "relation:add") this._add(payload);
      else if (type === "relation:update" && this.lineEls.has(payload.id)) styleLine(this.lineEls.get(payload.id), payload);
      else if (type === "relation:remove") this._remove(payload);
      // 덱이 움직이거나 크기가 바뀌었을 수 있으니(그리고 선이 생기고 지워지면 나란히 벌린 간격도
      // 달라지니) 무슨 변화든 전부 다시 맞춘다 — 관계선 수가 많지 않아 충분히 싸다.
      this.refresh();
    });

    layerEl.addEventListener("click", (e) => {
      const g = e.target.closest(".rel-line");
      if (g) this.onClick?.(g.dataset.id, e);
    });
  }

  renderAll() {
    for (const id of [...this.lineEls.keys()]) this._remove(id);
    for (const rel of this.model.relations.values()) this._add(rel);
    this.refresh();
  }

  _add(rel) {
    const g = createLineElement(rel);
    styleLine(g, rel);
    this.layerEl.append(g);
    this.lineEls.set(rel.id, g);
    this._applyScale(g);
  }

  _remove(id) {
    this.lineEls.get(id)?.remove();
    this.lineEls.delete(id);
    if (this.selectedId === id) this.selectedId = null;
  }

  setSelected(id) {
    this.lineEls.get(this.selectedId)?.classList.remove("selected");
    this.selectedId = id;
    const g = this.lineEls.get(id);
    g?.classList.add("selected");
    for (const el of this.lineEls.values()) this._applyScale(el);
    this.refresh(); // 굵기가 바뀌면 화살촉 크기도 바뀌어 선 끝을 다시 줄여야 한다
  }

  /** 화면 배율이 바뀔 때(main.js의 camera.onChange) 선 굵기를 다시 맞춘다. */
  updateScale() {
    for (const g of this.lineEls.values()) this._applyScale(g);
    this.refresh(); // 화살촉이 화면 기준 크기라 배율이 바뀌면 선 끝을 줄이는 길이도 바뀐다
  }

  _applyScale(g) {
    const scale = this.camera.scale || 1;
    const selected = g.classList.contains("selected");
    g.querySelector(".rel-line-visible")?.setAttribute("stroke-width", (selected ? LINE_SELECTED_TARGET_SCREEN_PX : LINE_TARGET_SCREEN_PX) / scale);
    g.querySelector(".rel-line-hit")?.setAttribute("stroke-width", LINE_HIT_TARGET_SCREEN_PX / scale);
  }

  /** 모든 관계선의 끝점을 지금 덱 위치·크기에 맞춘다(드래그 중에도 DeckRenderer가 불러줌). */
  refresh() {
    const rects = new Map(this.deckRenderer.rects().map((r) => [r.id, r]));
    // 같은 두 덱(방향 무관) 사이의 관계선끼리 묶어서, 겹치지 않게 나란히 벌린다.
    const groups = new Map();
    for (const rel of this.model.relations.values()) {
      const key = [rel.fromId, rel.toId].sort().join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rel);
    }
    for (const list of groups.values()) {
      list.forEach((rel, i) => {
        const g = this.lineEls.get(rel.id);
        const a = rects.get(rel.fromId);
        const b = rects.get(rel.toId);
        if (!g || !a || !b) return;
        // 묶음 안에서 기준 방향을 하나로 정해야(정렬된 id 순) A→B, B→A 선이 같은 쪽으로 안 겹친다.
        const flip = rel.fromId > rel.toId;
        const offset = (i - (list.length - 1) / 2) * PARALLEL_SPACING * (flip ? -1 : 1);
        const pts = edgeToEdge(a, b, offset);
        updateLinePosition(g, pts);
        if (rel.type === "arrow") this._trimForArrowheads(g, rel, pts);
      });
    }
  }

  /** 보이는 선(클릭 범위 선은 그대로)을 화살촉이 달린 끝에서 화살촉 길이만큼 줄인다 — 화살촉은 줄인 끝에
   * 밑변 쪽이 걸려서 뾰족한 끝이 원래 끝점에 오고, 네모난 선 끝은 화살촉 안에 가려진다. */
  _trimForArrowheads(g, rel, [p0, p1]) {
    const visible = g.querySelector(".rel-line-visible");
    const sw = parseFloat(visible.getAttribute("stroke-width")) || LINE_TARGET_SCREEN_PX / (this.camera.scale || 1);
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (!len) return;
    const d = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len };
    // 선이 너무 짧으면(덱이 바짝 붙음) 다 줄이지 않고 선 길이의 일부만.
    const trim = Math.min(arrowTrimLength(sw), len / (rel.bidirectional ? 2.5 : 1.5));
    const end = { x: p1.x - d.x * trim, y: p1.y - d.y * trim };
    const start = rel.bidirectional ? { x: p0.x + d.x * trim, y: p0.y + d.y * trim } : p0;
    visible.setAttribute("points", `${start.x},${start.y} ${end.x},${end.y}`);
  }
}

/** 가계도 applyLineStyle에 더해, 라벨 글자색도 선 색(지정했을 때만)과 맞춘다 — 카운터처럼 색으로
 * 구분하는 관계는 라벨까지 같은 색이어야 한눈에 들어온다. */
function styleLine(g, rel) {
  applyLineStyle(g, rel);
  g.querySelector(".rel-line-label").style.fill = rel.color || "";
}

/** 두 덱의 기준점(가로 가운데, 장수 초상화 높이 — DeckRenderer.rects의 anchorY)을 잇는 선(offset만큼
 * 수직으로 평행이동)을 각 사각형 테두리 밖에서 시작·끝나게 자른다. 기준점이 덱 전체 높이가 아니라
 * 초상화를 따라가서, 표시 단계를 바꿔 아래쪽 칸이 접히고 펴져도 선은 초상화를 가리킨 채 그대로다.
 * 두 덱이 겹쳐 있으면 그냥 기준점끼리 잇는다. */
function edgeToEdge(a, b, offset) {
  const ca = { x: a.x + a.width / 2, y: a.y + a.anchorY };
  const cb = { x: b.x + b.width / 2, y: b.y + b.anchorY };
  const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
  const d = { x: (cb.x - ca.x) / len, y: (cb.y - ca.y) / len };
  const n = { x: -d.y, y: d.x };
  const pa = { x: ca.x + n.x * offset, y: ca.y + n.y * offset };
  const pb = { x: cb.x + n.x * offset, y: cb.y + n.y * offset };
  const startEdge = exitPoint(pa, d, a, 0);
  const endEdge = exitPoint(pb, { x: -d.x, y: -d.y }, b, 0);
  const span = (endEdge.x - startEdge.x) * d.x + (endEdge.y - startEdge.y) * d.y; // 두 테두리 사이 거리
  // 두 덱이 겹쳐 있으면(테두리 사이가 음수) 그냥 중심끼리 잇는다.
  if (span <= 0) return [pa, pb];
  // 덱끼리 바짝 붙어 있으면 띄우는 간격을 줄여서라도 테두리 바깥에서 시작·끝나게 한다.
  const gap = Math.min(EDGE_GAP, span / 4);
  return [
    { x: startEdge.x + d.x * gap, y: startEdge.y + d.y * gap },
    { x: endEdge.x - d.x * gap, y: endEdge.y - d.y * gap },
  ];
}

/** 사각형 r 안의 점 p에서 방향 d로 나아가 테두리를 벗어나는 지점(+gap). */
function exitPoint(p, d, r, gap) {
  let t = Infinity;
  if (d.x > 0) t = Math.min(t, (r.x + r.width - p.x) / d.x);
  if (d.x < 0) t = Math.min(t, (r.x - p.x) / d.x);
  if (d.y > 0) t = Math.min(t, (r.y + r.height - p.y) / d.y);
  if (d.y < 0) t = Math.min(t, (r.y - p.y) / d.y);
  if (!Number.isFinite(t) || t < 0) t = 0;
  return { x: p.x + d.x * (t + gap), y: p.y + d.y * (t + gap) };
}
