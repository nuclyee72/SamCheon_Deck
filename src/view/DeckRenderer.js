import { DragController } from "../lib/DragController.js";
import { rectCollides, computeRectSnap } from "../lib/fieldSnap.js";
import { createDeckBoard, syncDeckBoard, positionDeckBoard, closeAllTactics, setBoardEditable } from "../ui/DeckBoard.js";
import { createListBoard, syncListBoard } from "../ui/ListBoard.js";
import { createTextBoard, syncTextBoard, sizeTextBoard, focusTextBoard } from "../ui/TextBoard.js";
import { createFieldBoard, syncFieldBoard } from "../ui/FieldBoard.js";
import { deckPortraitIds, generalKey, TEXT_BOX_DEFAULTS, TEXT_BOX_MIN, FIELD_DEFAULTS, FIELD_MIN } from "../core/DeckModel.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const SNAP_THRESHOLD_PX = 14; // 가계도 TreeRenderer와 같은 화면 기준 스냅 거리
// 정렬선 외에 "옆 덱에서 이만큼 띄운 자리"에도 스냅(나란히 늘어놓기 편하게). 사이에 관계선·라벨이
// 들어갈 자리가 있게 넉넉히 — 새 덱/복제본을 놓을 때(main.js)도 같은 간격을 쓴다.
export const DECK_GAP = 300;
// 드래그 스냅에만 쓰는 좁은 간격 — 관계선 없이 바짝(조금만 띄워) 붙여 놓고 싶을 때.
const DECK_GAP_NEAR = 30;
// 화면 밀림(_reflow): 위 덱이 길어져 닿으면 아래 덱을 이만큼은 띄운 채로 민다.
const REFLOW_GAP = DECK_GAP_NEAR;
// 텍스트 박스가 "바로 아래 덱의 라벨"로 따라 움직이는 거리(텍스트 박스 아래 끝 ~ 덱 위 끝).
const TEXT_ATTACH_GAP = 160;
const REFLOW_ANIM_MS = 160;
// 필드가 소속 덱들을 감쌀 때 둘레 여백.
const FIELD_PAD = 60;

/**
 * DeckModel → DOM 동기화 + 덱 필드 드래그(헤더로만)·정렬 스냅·겹침 방지·휴지통 삭제.
 * 덱 필드 크기는 모델에 없고 DOM에서 잰다(양식이 고정이라 사실상 일정함).
 *
 * 덱 위치(deck.x/y)는 사용자가 놓은 "제자리"이고, 밀림 때문에 바뀌지 않는다. 표시 단계·수정/보기 전환·
 * 입력(장비 칩 줄바꿈, 리스트 칸 추가)으로 덱이 길어져 아래 덱에 닿으면, 아래 덱을 화면에서만 필요한
 * 만큼 내려 보여주고(offsets) 다시 짧아지면 제자리로 돌아온다(_reflow). 그래서 많이↔적게, 수정↔보기를
 * 몇 번 오가도 배치가 그대로고, 밀림은 실행취소·저장에도 안 남는다. 겹침 판정·스냅·관계선은 화면 위치(rects).
 * 텍스트 박스(kind "text")는 크기를 모델에 들고 있고(모서리 손잡이로 조절), 상자 아무 데나 잡고 끈다.
 * 라벨처럼 덱 위·옆에 붙여 쓰는 것이라 겹침 방지에서는 빠진다(텍스트 박스도, 덱도 서로 막지 않음).
 * 필드(kind "field")는 덱들 밑에 깔리는 컨테이너 — 덱을 놓을 때 필드에 걸쳐 있으면 그 필드 소속(fieldId)이
 * 되고, 필드 크기는 소속 덱들을 감싸도록 화면에서 저절로 맞춰진다(fieldRects). 끌면 소속된 것이 같이 움직인다.
 */
export class DeckRenderer {
  constructor({ model, store, decksEl, fieldsEl, guidesEl, camera, trashEl, onInput, onAction, onSelect, onMove, onToggleOwned }) {
    this.model = model;
    this.store = store;
    this.decksEl = decksEl;
    this.fieldsEl = fieldsEl; // 필드는 관계선 밑 레이어에(index.html 순서: 필드 → 관계선 → 덱)
    this.guidesEl = guidesEl;
    this.camera = camera;
    this.trashEl = trashEl;
    this.onInput = onInput;
    this.onAction = onAction;
    this.onSelect = onSelect;
    this.onMove = onMove; // 드래그 중(모델 이벤트 없이 직접 옮기는 동안) 관계선을 따라오게 하는 데 씀
    this.onToggleOwned = onToggleOwned; // 보유 체크 모드에서 리스트 장수·전법 칸을 누를 때(종류, 이름)

    this.boardEls = new Map(); // deckId -> element
    this.boardDrags = new Map(); // deckId -> DragController[](헤더 / 텍스트 박스는 상자 + 모서리 손잡이 둘)
    this.portraitUrls = new Map(); // portraitId -> objectURL
    this._loadingPortraits = new Set();
    this.selectedId = null;
    this._drag = null;
    this.editable = true; // false = 보기 모드(입력·드래그·버튼 동작 전부 막음)
    // 리스트에서 누른 장수/전법 — { type: "general" | "tactic", key: generalKey(이름) } | null.
    // 같은 이름의 장수 칸 / 전법 칸을 보드 전체에서 강조한다.
    this.highlight = null;
    // 보유한 장수·전법 { general: Set, tactic: Set }(generalKey 이름) — 이 브라우저에만 저장(main.js).
    // 보유 체크 모드에서는 리스트의 장수·전법 칸을 누르면 강조 대신 보유를 켜고 끈다.
    this.owned = { general: new Set(), tactic: new Set() };
    this.ownedMode = false;

    // 화면 밀림 — deckId -> 제자리(deck.y)에서 아래로 얼마나 내려 보여주는지(px, 0 이상). 덱 높이가
    // 바뀌면(내용·표시 단계·수정/보기, 글꼴 로딩까지) ResizeObserver가 _reflow를 다시 부른다.
    this.offsets = new Map();
    // 필드 화면 사각형 — fieldId -> { x, y, width, height }(소속 덱들 + 여백). 소속이 없으면 마지막으로 맞췄던
    // 사각형(lastFieldFit, 이번 세션), 그것도 없으면 저장된 크기.
    this.fieldRects = new Map();
    this.lastFieldFit = new Map();
    this._anim = null; // 밀림 애니메이션 { from, to, start, raf }
    this._reflowQueued = false;
    this._resizeObserver = new ResizeObserver(() => this._scheduleReflow());

    model.onChange((type, payload) => this._handle(type, payload));
  }

  _handle(type, payload) {
    if (type === "reset") this.renderAll();
    else if (type === "deck:add") this._add(payload);
    else if (type === "deck:update") this._update(payload);
    else if (type === "deck:remove") this._remove(payload);
    // 리스트가 바뀌면(장수 이름·초상화, 추가/삭제) 덱 장수 카드의 "리스트에서 빌려 온 초상화"도 다시 맞춘다.
    // 지워진 덱은 종류를 모르니 그때도 다시 맞춘다.
    if ((type === "deck:add" || type === "deck:update") && payload.kind === "list" || type === "deck:remove") {
      for (const d of this.model.decks.values()) if (d.kind !== "list") this._sync(d);
    }
    if (type === "reset") this._reflow({ animate: false });
    else if (type.startsWith("deck:")) this._reflow();
  }

  renderAll() {
    this._stopAnim();
    for (const id of [...this.boardEls.keys()]) this._remove(id);
    for (const deck of this.model.decks.values()) this._add(deck);
  }

  _add(deck) {
    // 보기 모드에서는 입력/버튼 동작을 여기서 한 번 더 막는다(읽기 전용·숨김은 화면에서만 막는 것이라).
    const handlers = {
      onInput: (path, value) => this.editable && this.onInput(deck.id, path, value),
      onAction: (act, ctx) => this.editable && this.onAction(deck.id, act, ctx),
      onHighlight: (type, name, opts) => {
        if (this.ownedMode) this.onToggleOwned?.(type, name);
        else this.toggleHighlight(type, name, opts);
      },
    };
    const el = deck.kind === "list" ? createListBoard(deck, handlers)
      : deck.kind === "text" ? createTextBoard(deck, handlers)
      : deck.kind === "field" ? createFieldBoard(deck, handlers)
      : createDeckBoard(deck, handlers);
    // 필드는 관계선·덱들 밑의 따로 된 레이어에(필드끼리는 나중 것이 위).
    (deck.kind === "field" ? this.fieldsEl : this.decksEl).append(el);
    this.boardEls.set(deck.id, el);
    this._place(deck);
    this._resizeObserver.observe(el);
    if (deck.kind === "text") this._attachTextDrag(deck.id, el);
    else if (deck.kind === "field") this._attachFieldDrag(deck.id, el);
    else this._attachDrag(deck.id, el);
    // 덱 필드 아무 곳이나 누르면 선택(헤더 드래그와 별개로, 입력칸을 눌러도 선택은 됨).
    el.addEventListener("pointerdown", () => this.setSelected(deck.id));
    this._sync(deck);
  }

  _update(deck) {
    if (!this.boardEls.has(deck.id)) return;
    this._place(deck);
    this._sync(deck);
  }

  /** 화면 위치 = 제자리 + 밀림. 필드는 소속 덱들에 맞춘 사각형(위치 + 크기). */
  _place(deck) {
    const el = this.boardEls.get(deck.id);
    if (!el) return;
    if (deck.kind === "field") {
      const r = this.fieldRect(deck);
      positionDeckBoard(el, r);
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      return;
    }
    positionDeckBoard(el, { x: deck.x, y: deck.y + (this.offsets.get(deck.id) || 0) });
  }

  // ---------- 필드 크기 = 소속 덱들 ----------

  /** 필드의 화면 사각형. */
  fieldRect(field) {
    return this.fieldRects.get(field.id) || this.lastFieldFit.get(field.id) ||
      { x: field.x, y: field.y, width: field.width, height: field.height };
  }

  /** 필드에 소속된 것(덱·리스트·텍스트 박스) id들. */
  fieldMembers(fieldId) {
    const ids = [];
    for (const d of this.model.decks.values()) if (d.fieldId === fieldId && this.boardEls.has(d.id)) ids.push(d.id);
    return ids;
  }

  /** (x, y)를 품은 필드 id — 여럿이면 위에 그려진(나중) 것. 없으면 null. */
  fieldAt(x, y) {
    let found = null;
    for (const d of this.model.decks.values()) {
      if (d.kind !== "field") continue;
      const r = this.fieldRect(d);
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) found = d.id;
    }
    return found;
  }

  /** 사각형(x, y, w, h)이 걸쳐 있는 필드 id — 여럿이면 가장 많이 겹친 것. 없으면 null. 덱을 놓을 때 쓴다:
   * 필드가 소속 덱들에 딱 맞게 줄어 있어도, 가장자리에 걸쳐 놓기만 하면 들어가고(필드가 그만큼 늘어남)
   * 완전히 밖으로 빼야 빠진다. */
  fieldOverlapping(x, y, w, h) {
    let found = null;
    let best = 0;
    for (const d of this.model.decks.values()) {
      if (d.kind !== "field") continue;
      const r = this.fieldRect(d);
      const ow = Math.min(x + w, r.x + r.width) - Math.max(x, r.x);
      const oh = Math.min(y + h, r.y + r.height) - Math.max(y, r.y);
      if (ow > 0 && oh > 0 && ow * oh > best) { found = d.id; best = ow * oh; }
    }
    return found;
  }

  /** 소속 덱들의 화면 위치(밀림 포함)로 필드 사각형을 다시 맞춘다. */
  _fitFields() {
    const boxes = new Map(); // fieldId -> { minX, minY, maxX, maxY }
    for (const d of this.model.decks.values()) {
      if (!d.fieldId || d.kind === "field") continue;
      const el = this.boardEls.get(d.id);
      if (!el) continue;
      const x = d.x;
      const y = d.y + (this.offsets.get(d.id) || 0);
      const b = boxes.get(d.fieldId) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x + el.offsetWidth);
      b.maxY = Math.max(b.maxY, y + el.offsetHeight);
      boxes.set(d.fieldId, b);
    }
    this.fieldRects.clear();
    for (const d of this.model.decks.values()) {
      if (d.kind !== "field") continue;
      const b = boxes.get(d.id);
      this.boardEls.get(d.id)?.classList.toggle("has-members", !!b);
      if (!b) continue;
      const r = { x: b.minX - FIELD_PAD, y: b.minY - FIELD_PAD, width: b.maxX - b.minX + FIELD_PAD * 2, height: b.maxY - b.minY + FIELD_PAD * 2 };
      this.fieldRects.set(d.id, r);
      this.lastFieldFit.set(d.id, r);
    }
  }

  /** 필드 사각형을 다시 맞춰 그 자리에 — 바뀐 게 있으면 필드에 이어진 관계선도 따라오게. */
  _placeFields() {
    const before = JSON.stringify([...this.fieldRects]);
    this._fitFields();
    for (const d of this.model.decks.values()) if (d.kind === "field") this._place(d);
    if (JSON.stringify([...this.fieldRects]) !== before) this.onMove?.();
  }

  /** 필드의 저장된 사각형을 지금 화면 사각형으로 — 비게 되더라도 그 자리·크기 그대로 남게(실행취소엔 같은 묶음). */
  _commitFieldRect(fieldId) {
    const f = fieldId && this.model.decks.get(fieldId);
    if (!f || f.kind !== "field") return;
    const r = this.fieldRect(f);
    const next = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    if (next.x !== f.x || next.y !== f.y || next.width !== f.width || next.height !== f.height) this.model.updateDeck(f.id, next);
  }

  /** 표시 단계("full" | "normal" | "compact") — 덱 필드 안에서 어느 칸까지 보일지(style.css의
   * #decks-layer[data-view]). */
  setViewMode(mode) {
    this.changeLayout(() => { this.decksEl.dataset.view = mode; });
  }

  /** 수정 모드(true) / 보기 모드(false). 보기 모드의 생김새(수정용 버튼 숨김 등)는 main.js가 #app에
   * 거는 data-ui-mode로 CSS가 처리하고, 여기서는 입력칸 읽기 전용과 드래그 금지만 맡는다. */
  setEditable(editable) {
    this.editable = editable;
    for (const el of this.boardEls.values()) setBoardEditable(el, editable);
    if (!editable) this.setSelected(null);
  }

  /** 덱 높이를 바꿀 수 있는 화면 변경(fn)을 적용한다 — 길어진 덱이 아래 덱에 닿으면 화면에서만 밀고,
   * 짧아지면 제자리로(_reflow). 덱 위치(모델)는 안 바뀐다. */
  changeLayout(fn) {
    closeAllTactics();
    fn();
    this._reflow();
  }

  // ---------- 화면 밀림(제자리는 그대로) ----------

  _scheduleReflow() {
    if (this._reflowQueued) return;
    this._reflowQueued = true;
    requestAnimationFrame(() => {
      this._reflowQueued = false;
      this._reflow();
    });
  }

  /** 제자리(deck.x/y)와 지금 높이로 화면 위치를 다시 계산한다. 위에서부터 차례로, 가로로 겹치는 위쪽 덱의
   * (화면상) 아래 끝 + REFLOW_GAP보다 위에 있으면 그만큼만 내린다 — 닿지 않으면 제자리. 텍스트 박스는
   * 밀지도 밀리지도 않고, 겹쳐 있거나 바로 아래에 있는 덱을 따라 같이 내려간다(라벨이 떨어지지 않게).
   * 끄는 중에는 미뤄 뒀다가 놓을 때(모델 변경) 다시 계산한다. */
  _reflow({ animate = true } = {}) {
    if (this._drag) return;
    const items = [];
    for (const deck of this.model.decks.values()) {
      const el = this.boardEls.get(deck.id);
      if (el) items.push({ id: deck.id, kind: deck.kind, x: deck.x, y: deck.y, w: el.offsetWidth, h: el.offsetHeight });
    }
    const target = new Map();
    const solids = items.filter((it) => it.kind !== "text" && it.kind !== "field").sort((a, b) => a.y - b.y);
    const placed = [];
    for (const it of solids) {
      let y = it.y;
      for (const p of placed) {
        if (p.x >= it.x + it.w || p.x + p.w <= it.x) continue; // 가로로 안 겹치면 상관없음
        y = Math.max(y, p.dispY + p.h + REFLOW_GAP);
      }
      it.dispY = y;
      placed.push(it);
      target.set(it.id, y - it.y);
    }
    for (const t of items) {
      if (t.kind === "field") target.set(t.id, 0);
      if (t.kind !== "text") continue;
      const anchor = textAnchor(t, solids);
      target.set(t.id, anchor ? target.get(anchor.id) : 0);
    }
    this._animateOffsets(target, animate);
  }

  _animateOffsets(target, animate) {
    // 진행 중이던 애니메이션은 지금 위치에서 멈추고 거기서부터 새 목표로 간다.
    this._stopAnim({ snap: false });
    const from = new Map();
    let changed = false;
    for (const [id, to] of target) {
      const cur = this.offsets.get(id) || 0;
      from.set(id, cur);
      if (Math.abs(cur - to) > 0.5) changed = true;
    }
    for (const id of [...this.offsets.keys()]) if (!target.has(id)) this.offsets.delete(id);
    if (!changed) {
      this._placeFields(); // 밀림은 그대로여도 소속·크기가 바뀌었을 수 있다
      return;
    }
    if (!animate) {
      for (const [id, to] of target) this.offsets.set(id, to);
      this._placeAll();
      return;
    }
    const anim = { from, to: target, start: performance.now(), raf: 0 };
    const step = (now) => {
      const t = Math.min(1, (now - anim.start) / REFLOW_ANIM_MS);
      const e = 1 - (1 - t) ** 3;
      for (const [id, to] of anim.to) this.offsets.set(id, anim.from.get(id) + (to - anim.from.get(id)) * e);
      this._placeAll();
      if (t < 1) anim.raf = requestAnimationFrame(step);
      else this._anim = null;
    };
    this._anim = anim;
    anim.raf = requestAnimationFrame(step);
  }

  /** snap: true면 목표 위치로 바로(새로 그리기·끌기 시작 전), false면 지금 위치에서 멈춘다. */
  _stopAnim({ snap = true } = {}) {
    if (!this._anim) return;
    cancelAnimationFrame(this._anim.raf);
    if (snap) {
      for (const [id, to] of this._anim.to) this.offsets.set(id, to);
      this._placeAll();
    }
    this._anim = null;
  }

  /** 모든 덱을 화면 위치로 + 관계선도 따라오게. */
  _placeAll() {
    this._fitFields();
    for (const deck of this.model.decks.values()) this._place(deck);
    this.onMove?.();
  }

  _remove(id) {
    this.boardDrags.get(id)?.forEach((d) => d.destroy());
    this.boardDrags.delete(id);
    const el = this.boardEls.get(id);
    if (el) this._resizeObserver.unobserve(el);
    el?.remove();
    this.boardEls.delete(id);
    this.offsets.delete(id);
    this.fieldRects.delete(id);
    this.lastFieldFit.delete(id);
    if (this.selectedId === id) this.setSelected(null);
  }

  _sync(deck) {
    const el = this.boardEls.get(deck.id);
    const portraitUrlFor = (pid) => this._portraitUrl(pid, deck.id);
    if (deck.kind === "text") {
      syncTextBoard(el, deck);
      setBoardEditable(el, this.editable);
      return;
    }
    if (deck.kind === "field") {
      syncFieldBoard(el, deck);
      return;
    }
    if (deck.kind === "list") syncListBoard(el, deck, portraitUrlFor);
    else syncDeckBoard(el, deck, portraitUrlFor, this._listPortraitIndex());
    setBoardEditable(el, this.editable);
    this._applyHighlight(el, deck);
    this._applyOwned(el, deck);
  }

  /** 리스트 장수 이름(generalKey) → 초상화 id — 덱의 장수 카드에 초상화가 없으면 이름이 같은 리스트 장수의
   * 초상화를 대신 보여준다(데이터에는 안 넣고 화면에서만). 같은 이름이 여러 리스트에 있으면 먼저 나온 것. */
  _listPortraitIndex() {
    const index = new Map();
    for (const d of this.model.decks.values()) {
      if (d.kind !== "list") continue;
      for (const g of d.listGenerals) {
        const key = generalKey(g.name);
        if (key && g.portraitId && !index.has(key)) index.set(key, g.portraitId);
      }
    }
    return index;
  }

  // ---------- 보유 장수·전법(연두색 테두리) ----------

  setOwned(owned) {
    this.owned = owned;
    for (const [id, el] of this.boardEls) {
      const deck = this.model.decks.get(id);
      if (deck) this._applyOwned(el, deck);
    }
  }

  /** 보유한 장수 칸(리스트)·장수 카드(덱)·전법 칸(대체 전법 줄 포함)에 .owned, 이름은 있는데 보유하지 않은
   * 칸에 .unowned(빨간 테두리), 장수 3명을 모두 보유한 덱에 .all-owned. 미보유 표시는 그 종류(장수/전법)를 하나라도 체크한 사람에게만 —
   * 보유 체크를 안 쓰는 사람에게까지 전부 빨갛게 보이지 않게. */
  _applyOwned(el, deck) {
    const state = (type, name) => {
      const key = generalKey(name);
      if (!key) return null;
      if (this.owned[type].has(key)) return "owned";
      return this.owned[type].size ? "unowned" : null;
    };
    const mark = (node, st) => {
      node.classList.toggle("owned", st === "owned");
      node.classList.toggle("unowned", st === "unowned");
    };
    if (deck.kind === "text" || deck.kind === "field") return;
    if (deck.kind === "list") {
      el.querySelectorAll(".list-general").forEach((item, i) => mark(item, state("general", deck.listGenerals[i]?.name)));
      el.querySelectorAll(".list-tactic").forEach((item, i) => mark(item, state("tactic", deck.listTactics[i])));
      return;
    }
    el.querySelectorAll(".general-card").forEach((card, gi) => {
      const g = deck.generals[gi];
      mark(card, state("general", g?.name));
      card.querySelectorAll(".tactic").forEach((tEl, ti) => {
        const t = g?.tactics[ti];
        mark(tEl, state("tactic", t?.text));
        tEl.querySelectorAll(".tactic-alt-row").forEach((row, ai) => mark(row, state("tactic", t?.alternatives[ai])));
      });
    });
    el.classList.toggle("all-owned", deck.generals.length > 0 && deck.generals.every((g) => state("general", g.name) === "owned"));
  }

  // ---------- 같은 장수/전법 강조(리스트의 장수·전법 칸을 누르면) ----------

  /** 리스트의 장수/전법 칸을 누를 때 — 그 이름으로 강조한다. 이미 같은 것이 강조돼 있으면 끈다(단,
   * 이름을 고치려고 입력칸을 누른 경우는 끄지 않음). 빈 이름이면 강조를 끈다. */
  toggleHighlight(type, name, { typing = false } = {}) {
    const key = generalKey(name);
    const same = this.highlight?.type === type && this.highlight.key === key;
    this.setHighlight(key && (!same || typing) ? { type, key } : null);
  }

  /** hl: { type: "general" | "tactic", key } 또는 null(끄기). */
  setHighlight(hl) {
    this.highlight = hl?.key ? hl : null;
    for (const [id, el] of this.boardEls) {
      const deck = this.model.decks.get(id);
      if (deck) this._applyHighlight(el, deck);
    }
  }

  _applyHighlight(el, deck) {
    const hl = this.highlight;
    const match = (type, name) => !!hl && hl.type === type && generalKey(name) === hl.key;
    if (deck.kind === "text" || deck.kind === "field") return;
    if (deck.kind === "list") {
      el.querySelectorAll(".list-general").forEach((item, i) => item.classList.toggle("name-hl", match("general", deck.listGenerals[i]?.name)));
      el.querySelectorAll(".list-tactic").forEach((item, i) => item.classList.toggle("name-hl", match("tactic", deck.listTactics[i])));
      return;
    }
    el.querySelectorAll(".general-card").forEach((card, gi) => {
      const g = deck.generals[gi];
      card.classList.toggle("name-hl", match("general", g?.name));
      // 전법 칸 — 전법 자체가 같으면 그 칸을, 대체 전법 중에 같은 게 있으면 ▶와 그 대체 전법 줄을 강조.
      card.querySelectorAll(".tactic").forEach((tEl, ti) => {
        const t = g?.tactics[ti];
        tEl.classList.toggle("name-hl", match("tactic", t?.text));
        const altRows = tEl.querySelectorAll(".tactic-alt-row");
        let anyAlt = false;
        (t?.alternatives || []).forEach((alt, ai) => {
          const hit = match("tactic", alt);
          anyAlt ||= hit;
          altRows[ai]?.classList.toggle("name-hl", hit);
        });
        tEl.classList.toggle("alt-hl", anyAlt);
      });
    });
  }

  /** 캐시에 있으면 바로, 없으면 IndexedDB에서 읽어 온 뒤 그 덱을 다시 그린다. */
  _portraitUrl(portraitId, deckId) {
    const cached = this.portraitUrls.get(portraitId);
    if (cached) return cached;
    if (!this._loadingPortraits.has(portraitId)) {
      this._loadingPortraits.add(portraitId);
      this.store.getImage(portraitId).then((blob) => {
        this._loadingPortraits.delete(portraitId);
        if (!blob) return;
        this.portraitUrls.set(portraitId, URL.createObjectURL(blob));
        // 그 초상화를 쓰는 덱 + 리스트 초상화를 빌려 쓰는 덱(어느 덱인지 따로 안 세고 덱 전부)
        for (const d of this.model.decks.values()) {
          if (d.kind !== "list" || deckPortraitIds(d).includes(portraitId)) this._sync(d);
        }
      });
    }
    return null;
  }

  /** 방금 IndexedDB에 넣은 초상화를 캐시에도 바로 넣는다(다시 읽으러 가지 않게). */
  cachePortrait(portraitId, blob) {
    this.portraitUrls.set(portraitId, URL.createObjectURL(blob));
  }

  setSelected(id) {
    if (this.selectedId === id) return;
    this.boardEls.get(this.selectedId)?.classList.remove("selected");
    this.selectedId = id;
    this.boardEls.get(id)?.classList.add("selected");
    this.onSelect?.(id);
  }

  /** 겹침 판정·스냅·전체보기에 쓰는 사각형들(크기는 DOM 실측, 줌과 무관한 CSS px). 위치는 화면 위치(밀림 포함).
   * anchorY = 관계선 기준점 높이 — "비고 줄이 다 보일 때(많이/보통)의 장수 초상화 세로 가운데". 적게에서는
   * 비고 줄이 접혀 초상화가 올라가지만 기준점은 그대로 둬서, 표시 단계를 바꿔도 관계선이 안 움직인다. */
  rects() {
    const out = [];
    for (const deck of this.model.decks.values()) {
      const el = this.boardEls.get(deck.id);
      if (!el) continue;
      // 리스트에는 장수 카드가 없으니 헤더(시즌 제목) 높이에 건다. 텍스트 박스는 상자 세로 가운데(헤더는
      // 상자 위에 떠 있어서 기준으로 안 씀).
      const portrait = el.querySelector(".general-card .portrait");
      const anchorEl = deck.kind === "text" || deck.kind === "field" ? null : portrait || el.querySelector(".deck-header");
      let anchorY = anchorEl ? offsetTopWithin(anchorEl, el) + anchorEl.offsetHeight / 2 : el.offsetHeight / 2;
      if (portrait) anchorY += collapsedNotesHeight(el);
      if (deck.kind === "field") {
        // 관계선은 필드 가운데를 향해 필드 테두리에서 끝난다.
        const r = this.fieldRect(deck);
        out.push({ id: deck.id, kind: deck.kind, x: r.x, y: r.y, width: r.width, height: r.height, anchorY: r.height / 2 });
        continue;
      }
      out.push({ id: deck.id, kind: deck.kind, x: deck.x, y: deck.y + (this.offsets.get(deck.id) || 0), width: el.offsetWidth, height: el.offsetHeight, anchorY });
    }
    return out;
  }

  getBounds() {
    const rects = this.rects();
    if (!rects.length) return null;
    return {
      minX: Math.min(...rects.map((r) => r.x)),
      minY: Math.min(...rects.map((r) => r.y)),
      maxX: Math.max(...rects.map((r) => r.x + r.width)),
      maxY: Math.max(...rects.map((r) => r.y + r.height)),
    };
  }

  /** 새 필드 크기(빈 자리 찾기용) — 같은 종류("deck" | "list")가 이미 있으면 그걸 재고, 없으면 대략값.
   * 텍스트 박스는 크기가 모델 값이라 기본 크기. */
  measureBoardSize(kind = "deck") {
    if (kind === "text") return { width: TEXT_BOX_DEFAULTS.width, height: TEXT_BOX_DEFAULTS.height };
    if (kind === "field") return { width: FIELD_DEFAULTS.width, height: FIELD_DEFAULTS.height };
    for (const [id, el] of this.boardEls) {
      if ((this.model.decks.get(id)?.kind || "deck") === kind) return { width: el.offsetWidth, height: el.offsetHeight };
    }
    return kind === "list" ? { width: 552, height: 260 } : { width: 552, height: 900 };
  }

  // ---------- 드래그(헤더로만) ----------

  _attachDrag(id, el) {
    const header = el.querySelector(".deck-header");
    const drag = new DragController(header, {
      // 입력칸·셀렉트·버튼 위에서는 드래그를 시작하지 않는다(글자 선택·클릭이 돼야 함). 단 터치에서는
      // 덱 이름(시즌) 칸 위에서도 끌 수 있게 한다 — 폰에서는 ⠿가 너무 작아 손가락이 옆의 이름 칸에 잡힌다.
      // (살짝 누르기만 하면 드래그가 아니라 그대로 이름 칸에 입력)
      filter: (e) => this.editable && !e.target.closest(
        e.pointerType === "touch" ? "select, textarea, button, label, input:not(.deck-name)" : "input, select, textarea, button, label",
      ),
      onDragStart: () => this._beginDrag(id),
      onDragMove: (dx, dy, e) => this._moveDrag(dx / this.camera.scale, dy / this.camera.scale, e),
      onDragEnd: (e) => this._endDrag(e),
    });
    this.boardDrags.set(id, [drag]);
  }

  /** 필드 — 빈 곳 아무 데나 잡고 끌면 위에 올린 것과 같이 이동. 모서리 손잡이는 크기 조절. */
  _attachFieldDrag(id, el) {
    const move = new DragController(el, {
      filter: (e) => this.editable && !e.target.closest("button, .box-resize"),
      onDragStart: () => this._beginFieldDrag(id),
      onDragMove: (dx, dy, e) => this._moveFieldDrag(dx / this.camera.scale, dy / this.camera.scale, e),
      onDragEnd: (e) => this._endFieldDrag(e),
    });
    const resizers = [...el.querySelectorAll(".box-resize")].map((handle) => this._attachResize(id, el, handle));
    this.boardDrags.set(id, [move, ...resizers]);
  }

  _beginFieldDrag(id) {
    const field = this.model.decks.get(id);
    if (!field) return;
    closeAllTactics();
    this.setSelected(id);
    const el = this.boardEls.get(id);
    if (field.locked) {
      el?.classList.add("drag-locked-preview");
      this._drag = { id, locked: true, field: true };
      return;
    }
    this._stopAnim();
    // 소속된 것은 (위치 잠금한 것도) 전부 같이 — 필드째 옮기는 것이라 필드 안에서의 자리는 그대로다. 밀려
    // 내려가 보이던 덱은 보이는 자리에서 같이 움직인다(끄는 동안은 제자리 = 보이는 자리).
    const members = [];
    for (const mid of this.fieldMembers(id)) {
      const d = this.model.decks.get(mid);
      const mel = this.boardEls.get(mid);
      const off = this.offsets.get(mid) || 0;
      members.push({ id: mid, kind: d.kind, x: d.x, y: d.y + off, homeY: d.y, width: mel.offsetWidth, height: mel.offsetHeight });
      d.y += off;
      this.offsets.set(mid, 0);
    }
    // 끄는 동안 필드 자신도 화면 사각형(소속 덱에 맞춘 것)을 기준으로 — 놓으면 그 사각형이 저장된다.
    const r = this.fieldRect(field);
    const home = { x: field.x, y: field.y, width: field.width, height: field.height };
    Object.assign(field, { x: r.x, y: r.y, width: r.width, height: r.height });
    this._drag = {
      id, field: true, startX: r.x, startY: r.y, dx: 0, dy: 0,
      width: r.width, height: r.height, members, home,
    };
    el.classList.add("dragging");
    for (const m of members) this.boardEls.get(m.id)?.classList.add("dragging");
    this.trashEl?.classList.add("visible");
  }

  _moveFieldDrag(dxWorld, dyWorld, e) {
    const g = this._drag;
    if (!g || g.locked) return;
    const field = this.model.decks.get(g.id);
    if (!field) return;
    g.dx += dxWorld;
    g.dy += dyWorld;
    const memberIds = new Set(g.members.map((m) => m.id));
    const rects = this.rects().filter((r) => r.id !== g.id && !memberIds.has(r.id));
    const otherFields = rects.filter((r) => r.kind === "field");
    // 정렬 스냅은 다른 필드끼리만(Gagedo처럼) — 덱 간격(300) 스냅은 필드엔 안 맞는다.
    const snapped = computeRectSnap(otherFields, g.startX + g.dx, g.startY + g.dy, { id: g.id, width: g.width, height: g.height }, {
      threshold: SNAP_THRESHOLD_PX / this.camera.scale,
    });
    let nx = snapped.x, ny = snapped.y;
    let { guideX, guideY } = snapped;
    let extra = snapped.extraGuides;
    // 필드끼리는 겹치지 않고, 같이 옮기는 덱도 필드 밖의 다른 덱과 겹치는 자리로는 못 간다 — 한 축만
    // 막히면 그 축만 멈춰 벽을 타고, 둘 다 막히면 멈춘다(덱 드래그와 같은 규칙, 이미 겹쳐 있으면 안 막음).
    const solids = rects.filter((r) => r.kind !== "text" && r.kind !== "field");
    const collides = (x, y) => rectCollides(otherFields, g.width, g.height, x, y, null) ||
      g.members.some((m) => m.kind !== "text" && rectCollides(solids, m.width, m.height, m.x + (x - g.startX), m.y + (y - g.startY), null));
    if (collides(nx, ny) && !collides(field.x, field.y)) {
      const xOk = !collides(nx, field.y);
      const yOk = !collides(field.x, ny);
      if (xOk && !yOk) { ny = field.y; guideY = null; extra = []; }
      else if (yOk && !xOk) { nx = field.x; guideX = null; extra = []; }
      else { nx = field.x; ny = field.y; guideX = null; guideY = null; extra = []; }
    }
    field.x = nx;
    field.y = ny;
    for (const m of g.members) {
      const d = this.model.decks.get(m.id);
      if (!d) continue;
      d.x = m.x + (nx - g.startX);
      d.y = m.y + (ny - g.startY);
      this._place(d);
    }
    // 소속이 없는 빈 필드는 필드 자신의 x/y로, 있으면 옮긴 덱들에 다시 맞춰서.
    if (g.members.length) this._fitFields();
    else this.lastFieldFit.delete(g.id);
    this._place(field);
    this.onMove?.();
    this._setGuides(guideX, guideY, extra);
    this._setTrashArmed(this._isOverTrash(e.clientX, e.clientY));
  }

  _endFieldDrag(e) {
    const g = this._drag;
    this._drag = null;
    this.trashEl?.classList.remove("visible", "armed");
    this._setGuides(null, null, []);
    if (!g) return;
    this.boardEls.get(g.id)?.classList.remove("dragging", "drag-locked-preview");
    if (g.locked) return;
    for (const m of g.members) this.boardEls.get(m.id)?.classList.remove("dragging");
    const field = this.model.decks.get(g.id);
    if (!field) return;
    // 모델 변경 전에 전부 처음 자리로 돌려둔다 — 실행취소하면 원래 자리로 돌아오게(400ms 안의 변경은
    // UndoManager가 한 번으로 묶는다).
    const finals = [{ id: g.id, x: Math.round(field.x), y: Math.round(field.y), width: Math.round(g.width), height: Math.round(g.height) }];
    Object.assign(field, g.home);
    for (const m of g.members) {
      const d = this.model.decks.get(m.id);
      if (!d) continue;
      finals.push({ id: m.id, x: d.x, y: d.y });
      d.x = m.x;
      d.y = m.homeY;
    }
    if (this._isOverTrash(e.clientX, e.clientY)) {
      // 휴지통 — 필드와 소속된 것을 전부 같이 지운다(Gagedo와 같음).
      for (const m of g.members) this.model.removeDeck(m.id);
      this.model.removeDeck(g.id);
      return;
    }
    if (finals[0].x === Math.round(g.startX) && finals[0].y === Math.round(g.startY)) {
      this._reflow({ animate: false });
      return;
    }
    for (const { id, ...patch } of finals) this.model.updateDeck(id, patch);
  }

  /** 텍스트 박스 — 상자 아무 데나 잡고 끌면 이동, 끌지 않고 누르면 글자 입력. 입력 중(textarea 포커스)일
   * 때는 글자 위에서 끌면 글자 선택이라 이동은 헤더(⠿)·테두리로만. 모서리 손잡이는 크기 조절. */
  _attachTextDrag(id, el) {
    const move = new DragController(el, {
      filter: (e) => this.editable && !e.target.closest("button, .box-resize") &&
        !(el.classList.contains("editing") && e.target.closest("textarea")),
      onDragStart: () => this._beginDrag(id),
      onDragMove: (dx, dy, e) => this._moveDrag(dx / this.camera.scale, dy / this.camera.scale, e),
      onDragEnd: (e) => this._endDrag(e),
      onClick: (e) => { if (!e.target.closest(".deck-header")) focusTextBoard(el); },
    });
    const resizers = [...el.querySelectorAll(".box-resize")].map((handle) => this._attachResize(id, el, handle));
    this.boardDrags.set(id, [move, ...resizers]);
  }

  /** 모서리 손잡이 — 글자 크기는 그대로 두고 상자 폭/높이만. 오른쪽 아래(br)는 왼쪽 위가 고정, 왼쪽 위(tl)는
   * 오른쪽 아래가 고정이라 x/y도 같이 바뀐다. 끄는 동안은 직접 옮기고 끝날 때 한 번만 모델에 반영(실행취소 한 번). */
  _attachResize(id, el, handle) {
    const tl = handle.dataset.corner === "tl";
    const min = this.model.decks.get(id)?.kind === "field" ? FIELD_MIN : TEXT_BOX_MIN;
    let g = null;
    return new DragController(handle, {
      filter: () => this.editable && !this.model.decks.get(id)?.locked && !this.fieldRects.has(id),
      onDragStart: () => {
        const d = this.model.decks.get(id);
        if (!d) return;
        // 빈 필드는 보이는 사각형(마지막으로 맞췄던 크기일 수 있음)에서 시작해 저장된 크기로 바꾼다.
        if (d.kind === "field") {
          Object.assign(d, this.fieldRect(d));
          this.lastFieldFit.delete(id);
        }
        g = { x: d.x, y: d.y, width: d.width, height: d.height, dx: 0, dy: 0 };
        el.classList.add("resizing");
      },
      onDragMove: (dx, dy) => {
        const d = this.model.decks.get(id);
        if (!g || !d) return;
        g.dx += dx / this.camera.scale;
        g.dy += dy / this.camera.scale;
        const w = Math.max(min.width, g.width + (tl ? -g.dx : g.dx));
        const h = Math.max(min.height, g.height + (tl ? -g.dy : g.dy));
        Object.assign(d, { width: w, height: h, x: tl ? g.x + g.width - w : g.x, y: tl ? g.y + g.height - h : g.y });
        sizeTextBoard(el, d); // 폭·높이만 넣는 함수라 필드에도 그대로
        this._place(d);
        this.onMove?.();
      },
      onDragEnd: () => {
        const d = this.model.decks.get(id);
        el.classList.remove("resizing");
        if (!g || !d) return;
        const next = { x: d.x, y: d.y, width: Math.round(d.width), height: Math.round(d.height) };
        Object.assign(d, { x: g.x, y: g.y, width: g.width, height: g.height });
        g = null;
        this.model.updateDeck(id, next);
      },
    });
  }

  _beginDrag(id) {
    const deck = this.model.decks.get(id);
    if (!deck) return;
    closeAllTactics();
    this.setSelected(id);
    if (deck.locked) {
      this.boardEls.get(id)?.classList.add("drag-locked-preview");
      this._drag = { id, locked: true };
      return;
    }
    const el = this.boardEls.get(id);
    this._stopAnim();
    // 밀려 내려가 보이던 덱은 보이는 자리에서 끌기 시작한다(끄는 동안은 제자리 = 보이는 자리).
    const off = this.offsets.get(id) || 0;
    this._drag = {
      id, startX: deck.x, startY: deck.y + off, homeY: deck.y, dx: 0, dy: 0,
      width: el.offsetWidth, height: el.offsetHeight,
      free: deck.kind === "text", // 텍스트 박스는 겹침 방지 없이 아무 데나
    };
    deck.y += off;
    this.offsets.set(id, 0);
    el.classList.add("dragging");
    this.trashEl?.classList.add("visible");
  }

  _moveDrag(dxWorld, dyWorld, e) {
    const g = this._drag;
    if (!g || g.locked) return;
    const deck = this.model.decks.get(g.id);
    if (!deck) return;
    g.dx += dxWorld;
    g.dy += dyWorld;
    const others = this.rects().filter((r) => r.id !== g.id && r.kind !== "field");
    const me = { id: g.id, width: g.width, height: g.height };
    const snapped = computeRectSnap(others, g.startX + g.dx, g.startY + g.dy, me, {
      threshold: SNAP_THRESHOLD_PX / this.camera.scale,
      // 덱 높이는 안의 내용(장비 칩 줄바꿈 등)에 따라 제각각이라 중심 기준 간격 대신 테두리 기준 간격,
      // 세로 정렬은 위쪽끼리만.
      gap: [DECK_GAP, DECK_GAP_NEAR],
      topOnly: true,
    });
    let nx = snapped.x, ny = snapped.y;
    let { guideX, guideY } = snapped;
    // 다른 덱 필드와 겹치는 자리로는 못 간다 — 한 축만 막히면 그 축만 멈춰서 벽을 타고 미끄러지듯,
    // 둘 다 막히면 그 자리에 멈춘다(가계도 필드와 같은 규칙). 단, 이미 겹쳐 있는 상태(예: 다른
    // 기기에서 가져온 데이터)라면 막지 않는다 — 그래야 겹친 덱을 빼낼 수 있다.
    // 텍스트 박스는 막지도 막히지도 않는다(라벨처럼 덱 위에 얹어 쓸 수 있게).
    const solid = others.filter((r) => r.kind !== "text");
    const collides = (x, y) => rectCollides(solid, g.width, g.height, x, y, null);
    if (!g.free && collides(nx, ny) && !collides(deck.x, deck.y)) {
      const xOk = !collides(nx, deck.y);
      const yOk = !collides(deck.x, ny);
      if (xOk && !yOk) { ny = deck.y; guideY = null; }
      else if (yOk && !xOk) { nx = deck.x; guideX = null; }
      else { nx = deck.x; ny = deck.y; guideX = null; guideY = null; }
    }
    // 드래그 중엔 모델 이벤트(=실행취소 스냅샷·자동저장)를 쏘지 않고 직접 옮긴다 — 끝날 때 한 번만 반영.
    deck.x = nx;
    deck.y = ny;
    this._place(deck);
    this.onMove?.();
    this._setGuides(guideX, guideY, snapped.extraGuides);
    this._setTrashArmed(this._isOverTrash(e.clientX, e.clientY));
  }

  _endDrag(e) {
    const g = this._drag;
    this._drag = null;
    this.trashEl?.classList.remove("visible", "armed");
    this._setGuides(null, null, []);
    if (!g) return;
    const el = this.boardEls.get(g.id);
    el?.classList.remove("dragging", "drag-locked-preview");
    if (g.locked) return;
    const deck = this.model.decks.get(g.id);
    if (!deck) return;
    if (this._isOverTrash(e.clientX, e.clientY)) {
      // 위치를 원래대로 돌려둔 뒤 지운다 — 실행취소하면 원래 자리에 다시 나타나게.
      deck.x = g.startX;
      deck.y = g.homeY;
      this.model.removeDeck(g.id);
      return;
    }
    // 옮겼으면 놓은 자리(화면 위치)가 새 제자리. 안 옮겼으면 원래 제자리로 되돌리고 밀림을 다시 계산.
    // 놓은 자리가 필드에 걸쳐 있으면 그 필드 소속, 완전히 밖이면 소속 없음 — 필드 크기는 끄는 동안엔
    // 그대로라(놓을 때 다시 맞춤) 조금씩 끌어 놓으면 필드가 따라 넓어지고, 경계 밖으로 완전히 빼면 빠진다.
    const { x, y } = deck;
    deck.x = g.startX;
    deck.y = g.homeY;
    if (x === g.startX && y === g.startY) {
      this._reflow({ animate: false });
      return;
    }
    const oldField = deck.fieldId ?? null;
    const newField = this.fieldOverlapping(x, y, g.width, g.height);
    this.model.updateDeck(g.id, { x, y, fieldId: newField });
    // 저장된 필드 사각형도 맞춰 둔다 — 마지막 덱이 빠져 비게 된 필드는 그 자리·크기 그대로 남는다.
    this._commitFieldRect(oldField);
    if (newField !== oldField) this._commitFieldRect(newField);
  }

  _isOverTrash(clientX, clientY) {
    if (!this.trashEl) return false;
    const r = this.trashEl.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  _setTrashArmed(armed) {
    this.trashEl?.classList.toggle("armed", armed);
  }

  /** 정렬선(가로/세로 하나씩) + 간격 스냅 안내선(ㄱ자 토막들). 가계도와 같은 CSS 클래스를 쓴다. */
  _setGuides(guideX, guideY, extraGuides) {
    if (!this._guideV) {
      this._guideV = this._svgLine("snap-guide", { y1: -100000, y2: 100000 });
      this._guideH = this._svgLine("snap-guide", { x1: -100000, x2: 100000 });
      this._extraGuideEls = [];
    }
    this._showLine(this._guideV, guideX !== null ? { x1: guideX, x2: guideX } : null);
    this._showLine(this._guideH, guideY !== null ? { y1: guideY, y2: guideY } : null);
    extraGuides.forEach((g, i) => {
      if (!this._extraGuideEls[i]) this._extraGuideEls[i] = this._svgLine("family-snap-guide", {});
      this._showLine(this._extraGuideEls[i], g);
    });
    for (let i = extraGuides.length; i < this._extraGuideEls.length; i++) this._showLine(this._extraGuideEls[i], null);
  }

  _svgLine(cls, attrs) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", cls);
    for (const [k, v] of Object.entries(attrs)) line.setAttribute(k, v);
    this.guidesEl.append(line);
    return line;
  }

  _showLine(line, attrs) {
    if (!attrs) { line.style.display = "none"; return; }
    for (const [k, v] of Object.entries(attrs)) line.setAttribute(k, v);
    line.style.display = "inline"; // ""로 비우면 CSS의 display:none으로 돌아가 버린다
  }
}

/** el의 위쪽이 ancestor 위쪽에서 얼마나 아래에 있는지(CSS px, 줌과 무관). */
function offsetTopWithin(el, ancestor) {
  let y = 0;
  for (let n = el; n && n !== ancestor; n = n.offsetParent) y += n.offsetTop;
  return y;
}

/** 덱의 비고 줄(비고 + 전형)이 많이/보통일 때보다 지금 얼마나 덜 차지하는지 — 적게에서 비고가 숨으면
 * 그만큼 초상화가 올라가니, 관계선 기준점을 그만큼 내려 원래 자리에 둔다. 비고 칸은 높이가 고정이라
 * 숨어 있어도(display:none) 계산된 스타일로 원래 높이를 알 수 있다. */
function collapsedNotesHeight(boardEl) {
  const row = boardEl.querySelector(".deck-notes-row");
  const notes = boardEl.querySelector(".deck-notes");
  if (!row || !notes) return 0;
  const gap = parseFloat(getComputedStyle(boardEl).rowGap) || 0;
  const full = (parseFloat(getComputedStyle(notes).height) || 0) + gap;
  const now = row.offsetHeight ? row.offsetHeight + gap : 0;
  return Math.max(0, full - now);
}

/** 텍스트 박스가 따라 움직일 덱 — 겹쳐 있는 덱(가장 많이 겹친 것), 없으면 바로 아래(가로로 겹치고 아래 끝에서
 * TEXT_ATTACH_GAP 안쪽)에서 가장 가까운 덱. 둘 다 없으면 null(제자리 고정). 위치는 전부 제자리 기준. */
function textAnchor(t, solids) {
  let best = null;
  let bestArea = 0;
  for (const s of solids) {
    const w = Math.min(t.x + t.w, s.x + s.w) - Math.max(t.x, s.x);
    const h = Math.min(t.y + t.h, s.y + s.h) - Math.max(t.y, s.y);
    if (w > 0 && h > 0 && w * h > bestArea) { best = s; bestArea = w * h; }
  }
  if (best) return best;
  let bestDist = Infinity;
  for (const s of solids) {
    if (s.x >= t.x + t.w || s.x + s.w <= t.x) continue;
    const dist = s.y - (t.y + t.h);
    if (dist >= 0 && dist <= TEXT_ATTACH_GAP && dist < bestDist) { best = s; bestDist = dist; }
  }
  return best;
}
