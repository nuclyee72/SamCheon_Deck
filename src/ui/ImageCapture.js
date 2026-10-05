import { DragController } from "../lib/DragController.js";

/**
 * 📷 이미지로 저장 — 툴바 📷를 누르면 영역 고르기 모드. 대충 끌어서 사각형을 그리면 그 안에 절반 이상
 * 들어간 덱·리스트·텍스트 박스·필드를 고르고, 결과 틀은 고른 것들에 딱 맞춰 여백(PAD)만 두고 자른다.
 * 덱·필드를 누르면 그것 하나만, Shift+누르기·Shift+끌기는 지금 고른 것에 더하기(Shift+누르기는 빼기도),
 * "전체"는 보드 전체. 아무것도 안 걸치게 끌면 끈 사각형 그대로. "저장"을 누르면 틀 안을 PNG로 받는다.
 * 화면에 보이는 그대로 찍는다(수정/보기 모드·표시 단계·테마·강조·보유 체크 등 — 고른 표시만 빼고).
 *
 * 틀은 월드 좌표라 고르는 중에도 휠·두 손가락으로 확대/축소할 수 있다. 찍는 방법은 아래
 * renderStageRegion 참고(라이브러리 없이 이 페이지의 CSS를 그대로 쓴 SVG를 캔버스에 그린다).
 */

/** 고른 것들 둘레 여백(월드 px) — 덱 그림자가 안 잘리고, 덱 간격(가까운 스냅 30)보다 작아서 옆 덱이 안 걸친다. */
const PAD = 24;
/** 끈 사각형 안에 이만큼(넓이 비율) 들어간 것만 고른다 — 옆 덱 가장자리를 살짝 스친 건 빼고, 대충 덮은 건 넣게. */
const CATCH_RATIO = 0.5;
/** 끈 사각형이 이보다 작으면(월드 px) 고르기 취소 — 살짝 끈 것을 영역으로 치지 않게. */
const MIN_SIZE = 8;
/** 결과 이미지 배율(덱 1px = 이미지 2px)과 크기 한도 — iOS 사파리 캔버스 한도(약 1677만 화소)·변 길이
 * 한도를 넘으면 배율을 낮춰서 맞춘다. */
const BASE_RATIO = 2;
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 16384;

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

export class ImageCapture {
  /**
   * layerEl: #viewport 안에서 캔버스를 덮는 투명 판(고르는 동안만 보임, 덱 조작을 막음)
   * barEl: 화면 위쪽 가운데 안내·버튼 줄
   * onSave(blob): PNG가 만들어지면 / onToggle(active): 모드가 켜지고 꺼질 때
   */
  constructor({ viewportEl, stageEl, layerEl, barEl, camera, renderer, onSave, onToggle }) {
    this.viewportEl = viewportEl;
    this.stageEl = stageEl;
    this.layerEl = layerEl;
    this.barEl = barEl;
    this.camera = camera;
    this.renderer = renderer;
    this.onSave = onSave;
    this.onToggle = onToggle;

    this.active = false;
    this.items = new Set(); // 고른 덱·리스트·텍스트 박스·필드 id
    this.rect = null; // 결과 틀(월드 좌표) { x, y, width, height } | null — 고른 게 있으면 그것들 + 여백
    this._busy = false;
    this._rectEl = layerEl.querySelector(".capture-rect");
    this._hintEl = barEl.querySelector(".capture-hint");
    this._saveBtn = barEl.querySelector('[data-capture="save"]');

    this._drawing = false;
    this._dragCaught = 0; // 끄는 동안 걸린 개수(안내 문구용)
    this._before = null; // 끌기 전 상태 { items, rect } — 너무 작게 끌었거나 두 손가락 줌으로 취소되면 되돌린다
    let from = null;
    // 끄는 동안은 끈 사각형 그대로 보이고 걸린 것에 테두리, 놓으면 틀이 걸린 것들에 맞춰 줄어든다.
    const dragIds = (raw, add) => new Set([...(add ? this._before.items : []), ...this._caught(raw)]);
    this._drag = new DragController(layerEl, {
      filter: (e) => !this._busy && (e.pointerType !== "mouse" || e.button === 0),
      onDragStart: () => {
        this._drawing = true;
        this._before = { items: this.items, rect: this.rect };
        from = camera.screenToWorld(this._drag.startX, this._drag.startY);
      },
      onDragMove: (dx, dy, e) => {
        const raw = rectFromPoints(from, camera.screenToWorld(e.clientX, e.clientY));
        const ids = dragIds(raw, e.shiftKey);
        this._highlight(ids);
        this._dragCaught = ids.size;
        this._setRect(raw);
      },
      onDragEnd: (e) => {
        this._drawing = false;
        const raw = this.rect;
        if (!raw || raw.width < MIN_SIZE || raw.height < MIN_SIZE) return this._restore(this._before);
        this._select(dragIds(raw, e.shiftKey), raw);
      },
      onClick: (e) => this._pick(e),
    });

    barEl.addEventListener("click", (e) => {
      const act = e.target.closest("button[data-capture]")?.dataset.capture;
      if (act === "all") this.selectAll();
      else if (act === "save") this.save();
      else if (act === "cancel") this.exit();
    });
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.layerEl.hidden = false;
    this.barEl.hidden = false;
    this._select(new Set());
    this.onToggle?.(true);
  }

  exit() {
    if (!this.active || this._busy) return;
    this.cancelDrag();
    this._highlight(new Set());
    this.active = false;
    this.layerEl.hidden = true;
    this.barEl.hidden = true;
    this.onToggle?.(false);
  }

  /** 두 손가락 줌이 시작되면 그리던 사각형을 버리고 끌기 전으로. */
  cancelDrag() {
    this._drag.cancelDrag();
    if (!this._drawing) return;
    this._drawing = false;
    this._restore(this._before);
  }

  /** 카메라가 움직이면 틀 표시를 따라 옮긴다. */
  updateScale() {
    if (this.active) this._renderRect();
  }

  selectAll() {
    const b = this.renderer.getBounds();
    if (!b) return;
    this._select(new Set(this.renderer.rects().map((r) => r.id)));
    this.camera.fitToContent(b);
  }

  async save() {
    if (!this.rect || this._busy) return;
    // 고르는 사이 보기 모드·표시 단계를 바꿨으면 덱 크기가 달라졌을 수 있다 — 틀을 지금 크기로 다시 맞춘다.
    if (this.items.size) this._setRect(this._fitRect(this.items));
    this._setBusy(true);
    try {
      const blob = await this._capture(this.rect);
      if (!blob) throw new Error("빈 이미지");
      this.onSave(blob);
      this._setBusy(false);
      this.exit();
    } catch (err) {
      console.error(err);
      this._setBusy(false);
      alert("이미지를 만드는 중 문제가 발생했습니다. 영역을 조금 작게 골라 다시 해보세요.");
    }
  }

  // ---------- 내부 ----------

  /** 누른 자리의 덱(리스트·텍스트 박스 포함, 겹치면 위의 것) → 없으면 필드를 고른다. Shift면 지금 고른 것에
   * 더하거나(이미 있으면 뺀다). 빈 곳이면 그대로 둔다. */
  _pick(e) {
    const p = this.camera.screenToWorld(e.clientX, e.clientY);
    const hits = this.renderer.rects().filter((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height);
    const hit = hits.filter((r) => r.kind !== "field").pop() || hits.pop();
    if (!hit) return;
    const ids = new Set(e.shiftKey ? this.items : []);
    if (e.shiftKey && ids.has(hit.id)) ids.delete(hit.id);
    else ids.add(hit.id);
    this._select(ids);
  }

  /** ids를 고른다 — 틀은 그것들을 감싼 사각형 + 여백. 하나도 없으면 raw(끈 사각형) 그대로, 그것도 없으면 틀 없음. */
  _select(ids, raw = null) {
    this.items = ids;
    this._highlight(ids);
    this._setRect(ids.size ? this._fitRect(ids) : raw);
  }

  _restore({ items, rect }) {
    this.items = items;
    this._highlight(items);
    this._setRect(rect);
  }

  _fitRect(ids) {
    const rs = this.renderer.rects().filter((r) => ids.has(r.id));
    if (!rs.length) return null;
    const minX = Math.min(...rs.map((r) => r.x));
    const minY = Math.min(...rs.map((r) => r.y));
    const maxX = Math.max(...rs.map((r) => r.x + r.width));
    const maxY = Math.max(...rs.map((r) => r.y + r.height));
    return padRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }

  /** 사각형 안에 넓이 CATCH_RATIO 이상 들어간 것들의 id. */
  _caught(area) {
    return this.renderer.rects().filter((r) => insideRatio(r, area) >= CATCH_RATIO).map((r) => r.id);
  }

  /** 고른 것에 테두리(.capture-hit) — 결과 이미지에서는 뺀다(renderStageRegion). */
  _highlight(ids) {
    for (const [id, el] of this.renderer.boardEls) el.classList.toggle("capture-hit", ids.has(id));
  }

  _setRect(rect) {
    this.rect = rect || null;
    this._renderRect();
    this._saveBtn.disabled = !this.rect;
    if (!this.rect) {
      this._hintEl.textContent = "저장할 덱들을 대충 끌어서 고르세요 · 덱·필드는 누르면 그것만";
      return;
    }
    if (this._drawing) {
      this._hintEl.textContent = this._dragCaught ? `${this._dragCaught}개 걸림 · 놓으면 거기에 맞춰 자름` : "걸린 덱 없음 · 놓으면 끈 영역 그대로";
      return;
    }
    const { width, height, ratio } = outputSize(this.rect);
    const size = `${Math.round(width * ratio)} × ${Math.round(height * ratio)}px`;
    this._hintEl.textContent = this.items.size ? `${this.items.size}개에 맞춤 · ${size}` : `고른 덱 없음(끈 영역 그대로) · ${size}`;
  }

  _renderRect() {
    const r = this.rect;
    this._rectEl.hidden = !r;
    if (!r) return;
    const { panX, panY, scale } = this.camera;
    const s = this._rectEl.style;
    s.left = `${panX + r.x * scale}px`;
    s.top = `${panY + r.y * scale}px`;
    s.width = `${r.width * scale}px`;
    s.height = `${r.height * scale}px`;
  }

  _setBusy(busy) {
    this._busy = busy;
    this.barEl.classList.toggle("busy", busy);
    for (const b of this.barEl.querySelectorAll("button")) b.disabled = busy || (b === this._saveBtn && !this.rect);
    this._saveBtn.textContent = busy ? "저장 중…" : "저장";
  }

  _capture(rect) {
    const size = outputSize(rect);
    const inside = new Set(this.renderer.rects().filter((r) => overlaps(r, size)).map((r) => r.id));
    return renderStageRegion({
      ...size,
      stageEl: this.stageEl,
      background: getComputedStyle(this.viewportEl).backgroundColor, // 점 무늬 없이 바탕색만
      keep: (id) => inside.has(id),
    });
  }
}

// ---------- 찍기 ----------

/**
 * #stage의 (x, y, width, height) 영역을 width·ratio × height·ratio PNG Blob으로.
 *
 * #stage를 통째로 복제하고, 이 페이지의 스타일시트를 <style> 하나로 넣어 SVG <foreignObject>에 담은 뒤
 * 캔버스에 그린다. 요소마다 계산된 스타일을 복사하는 방식(html-to-image 등)은 이 보드(요소 1만 2천 개
 * 남짓)에서 SVG가 100MB를 넘고 10초 넘게 걸렸다 — 같은 CSS를 그대로 쓰면 작고 빠르고, 관계선 SVG·
 * ::before 같은 것도 화면과 똑같이 나온다. 그러려면:
 * - 조상(#app, #viewport)도 껍데기만 복제해 감싼다 — #app[data-ui-mode="view"] 같은 선택자가 맞게.
 * - <html>의 속성(data-theme)은 SVG 뿌리에 옮긴다 — 그림 안에서는 SVG 뿌리가 :root라서
 *   :root[data-theme="dark"]의 색 변수가 그대로 맞는다. html·body에 준 글꼴·글자색은 바깥 div에.
 * - @media는 지금 화면에서 맞는 것만 풀어서 넣는다(그림 안의 화면 크기로 다시 판단하지 않게).
 * - 입력칸·셀렉트의 지금 값은 복제되지 않으니 속성으로 적고, 초상화(blob: 주소)는 data: URL로 바꾼다
 *   (SVG 그림 안에서는 바깥 파일을 못 읽는다).
 * keep(id): 영역에 걸친 덱·필드만 남긴다(나머지는 지워서 가볍게). 정렬 안내선은 뺀다.
 */
async function renderStageRegion({ stageEl, x, y, width, height, ratio, background, keep }) {
  const clone = stageEl.cloneNode(true);
  copyFormState(stageEl, clone); // 요소를 지우기 전에 — 원본과 순서가 같아야 한다
  clone.classList.remove("is-transforming");
  for (const el of clone.querySelectorAll(".capture-hit")) el.classList.remove("capture-hit"); // 고른 표시는 안 찍는다
  clone.style.transform = `translate(${-x}px, ${-y}px)`;
  clone.querySelector("#lines-layer")?.remove();
  for (const el of clone.querySelectorAll(".deck-board")) if (!keep(el.dataset.id)) el.remove();
  await inlineImages(clone);

  let content = clone;
  for (let a = stageEl.parentElement; a && a !== document.body; a = a.parentElement) {
    const shell = a.cloneNode(false);
    Object.assign(shell.style, {
      display: "block", position: "relative", width: `${width}px`, height: `${height}px`,
      margin: "0", padding: "0", border: "0", overflow: "hidden", background: "none", transform: "none",
    });
    shell.append(content);
    content = shell;
  }
  const page = document.createElementNS(XHTML_NS, "div");
  const bodyStyle = getComputedStyle(document.body);
  Object.assign(page.style, {
    width: `${width}px`, height: `${height}px`, overflow: "hidden",
    fontFamily: bodyStyle.fontFamily, fontSize: bodyStyle.fontSize, lineHeight: bodyStyle.lineHeight, color: bodyStyle.color,
  });
  const style = document.createElementNS(XHTML_NS, "style");
  style.textContent = pageCSS();
  page.append(style, content);

  const outW = Math.max(1, Math.round(width * ratio));
  const outH = Math.max(1, Math.round(height * ratio));
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const { name, value } of document.documentElement.attributes) svg.setAttribute(name, value);
  // 그림 자체를 결과 크기로 — 캔버스에 늘려 그리지 않으니 글자·선이 흐려지지 않는다.
  svg.setAttribute("width", outW);
  svg.setAttribute("height", outH);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const fo = document.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("width", width);
  fo.setAttribute("height", height);
  fo.append(page);
  svg.append(fo);

  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, 0, 0, outW, outH);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** cloneNode는 입력칸에 친 글자·고른 값을 안 옮긴다(속성이 아니라서) — 복제본에 속성으로 적는다. */
function copyFormState(src, dst) {
  const sel = "input, textarea, select";
  const from = src.querySelectorAll(sel);
  const to = dst.querySelectorAll(sel);
  from.forEach((o, i) => {
    const c = to[i];
    if (o.tagName === "TEXTAREA") c.textContent = o.value;
    else if (o.tagName === "SELECT") [...o.options].forEach((opt, j) => c.options[j]?.toggleAttribute("selected", opt.selected));
    else if (o.type === "checkbox" || o.type === "radio") c.toggleAttribute("checked", o.checked);
    else c.setAttribute("value", o.value);
  });
}

/** <img>를 data: URL로(같은 주소는 한 번만 읽음). 못 읽은 그림은 빈칸. */
async function inlineImages(root) {
  const cache = new Map();
  const toDataURL = (url) => fetch(url)
    .then((res) => res.blob())
    .then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }))
    .catch(() => "");
  await Promise.all([...root.querySelectorAll("img")].map(async (img) => {
    const src = img.src;
    if (!src || src.startsWith("data:")) return;
    if (!cache.has(src)) cache.set(src, toDataURL(src));
    const data = await cache.get(src);
    if (data) img.setAttribute("src", data);
    else img.removeAttribute("src");
  }));
}

/** 이 페이지의 CSS 전부 — @media는 지금 화면에서 맞는 것만 안쪽 규칙을 풀어서. */
function pageCSS() {
  const out = [];
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.media && rule.cssRules) {
        if (matchMedia(rule.media.mediaText).matches) walk(rule.cssRules);
      } else {
        out.push(rule.cssText);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* 다른 출처 스타일시트는 못 읽는다(지금은 없음) */ }
  }
  return out.join("\n");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("SVG 그림을 못 읽었습니다"));
    img.src = src;
  });
}

/** 영역을 정수 px로 맞추고, 크기 한도 안에서 가장 큰 배율(최대 BASE_RATIO)을 고른다. */
function outputSize(rect) {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const width = Math.max(1, Math.ceil(rect.x + rect.width) - x);
  const height = Math.max(1, Math.ceil(rect.y + rect.height) - y);
  const ratio = Math.min(BASE_RATIO, Math.sqrt(MAX_PIXELS / (width * height)), MAX_SIDE / width, MAX_SIDE / height);
  return { x, y, width, height, ratio };
}

function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function padRect(r) {
  return { x: r.x - PAD, y: r.y - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

/** r의 넓이 중 area 안에 든 비율(0~1). */
function insideRatio(r, area) {
  const w = Math.min(r.x + r.width, area.x + area.width) - Math.max(r.x, area.x);
  const h = Math.min(r.y + r.height, area.y + area.height) - Math.max(r.y, area.y);
  return w > 0 && h > 0 ? (w * h) / (r.width * r.height || 1) : 0;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
