import { DragController } from "../lib/DragController.js";
import { rectCollides, computeRectSnap } from "../lib/fieldSnap.js";
import { createDeckBoard, syncDeckBoard, positionDeckBoard, closeAllTactics, setBoardEditable } from "../ui/DeckBoard.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const SNAP_THRESHOLD_PX = 14; // 가계도 TreeRenderer와 같은 화면 기준 스냅 거리
const DECK_GAP = 40; // 정렬선 외에 "옆 덱에서 이만큼 띄운 자리"에도 스냅(나란히 늘어놓기 편하게)

/**
 * DeckModel → DOM 동기화 + 덱 필드 드래그(헤더로만)·정렬 스냅·겹침 방지·휴지통 삭제.
 * 덱 필드 크기는 모델에 없고 DOM에서 잰다(양식이 고정이라 사실상 일정함).
 */
export class DeckRenderer {
  constructor({ model, store, decksEl, guidesEl, camera, trashEl, onInput, onAction, onSelect, onMove }) {
    this.model = model;
    this.store = store;
    this.decksEl = decksEl;
    this.guidesEl = guidesEl;
    this.camera = camera;
    this.trashEl = trashEl;
    this.onInput = onInput;
    this.onAction = onAction;
    this.onSelect = onSelect;
    this.onMove = onMove; // 드래그 중(모델 이벤트 없이 직접 옮기는 동안) 관계선을 따라오게 하는 데 씀

    this.boardEls = new Map(); // deckId -> element
    this.boardDrags = new Map(); // deckId -> DragController(헤더)
    this.portraitUrls = new Map(); // portraitId -> objectURL
    this._loadingPortraits = new Set();
    this.selectedId = null;
    this._drag = null;
    this.editable = true; // false = 보기 모드(입력·드래그·버튼 동작 전부 막음)

    model.onChange((type, payload) => this._handle(type, payload));
  }

  _handle(type, payload) {
    if (type === "reset") this.renderAll();
    else if (type === "deck:add") this._add(payload);
    else if (type === "deck:update") this._update(payload);
    else if (type === "deck:remove") this._remove(payload);
  }

  renderAll() {
    for (const id of [...this.boardEls.keys()]) this._remove(id);
    for (const deck of this.model.decks.values()) this._add(deck);
  }

  _add(deck) {
    // 보기 모드에서는 입력/버튼 동작을 여기서 한 번 더 막는다(읽기 전용·숨김은 화면에서만 막는 것이라).
    const el = createDeckBoard(deck, {
      onInput: (path, value) => this.editable && this.onInput(deck.id, path, value),
      onAction: (act, ctx) => this.editable && this.onAction(deck.id, act, ctx),
    });
    positionDeckBoard(el, deck);
    this.decksEl.append(el);
    this.boardEls.set(deck.id, el);
    this._attachDrag(deck.id, el);
    // 덱 필드 아무 곳이나 누르면 선택(헤더 드래그와 별개로, 입력칸을 눌러도 선택은 됨).
    el.addEventListener("pointerdown", () => this.setSelected(deck.id));
    this._sync(deck);
  }

  _update(deck) {
    const el = this.boardEls.get(deck.id);
    if (!el) return;
    const oldHeight = el.offsetHeight;
    positionDeckBoard(el, deck);
    this._sync(deck);
    if (el.offsetHeight > oldHeight) this._resolveGrowth(new Map([[deck.id, oldHeight]]));
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

  /** 덱 높이를 바꿀 수 있는 화면 변경(fn)을 적용한다 — 그 결과 길어진 덱이 아래 덱과 겹치면 밀어낸다. */
  changeLayout(fn) {
    const oldHeights = new Map(this.rects().map((r) => [r.id, r.height]));
    closeAllTactics();
    fn();
    this._resolveGrowth(oldHeights);
  }

  /** 덱 높이가 늘어(장비/탈것 칩 줄바꿈, 보기 모드 변경 등) 아래 덱과 겹치게 되면 그 덱을 원래
   * 간격을 유지한 채 아래로 민다. oldHeights: 늘어나기 전 높이(목록에 없는 덱은 안 변한 것으로 침).
   * 위에서부터 차례로 보며, 원래 "완전히 아래"에 있던 덱이 이제 겹치면 밀고 — 밀린 덱도 순서가
   * 오면 다시 자기 아래를 민다(연쇄). 모델 변경이라 높이를 늘린 동작과 같은 실행취소 단위로 묶인다. */
  _resolveGrowth(oldHeights) {
    const rects = this.rects();
    const orig = new Map(rects.map((r) => [r.id, { y: r.y, h: oldHeights.get(r.id) ?? r.height }]));
    const pos = new Map(rects.map((r) => [r.id, r.y]));
    const sorted = [...rects].sort((a, b) => a.y - b.y);
    for (const d of sorted) {
      const o = orig.get(d.id);
      const bottom = pos.get(d.id) + d.height;
      for (const e of sorted) {
        if (e === d) continue;
        const eo = orig.get(e.id);
        if (eo.y < o.y + o.h) continue; // 원래 d보다 완전히 아래에 있던 덱만(옆에 있거나 이미 겹쳐 있던 건 제외)
        if (e.x >= d.x + d.width || e.x + e.width <= d.x) continue; // 가로로 안 겹치면 상관없음
        if (pos.get(e.id) >= bottom) continue; // 아직 안 겹침
        pos.set(e.id, bottom + (eo.y - (o.y + o.h)));
      }
    }
    for (const r of rects) {
      if (pos.get(r.id) !== r.y) this.model.updateDeck(r.id, { y: pos.get(r.id) });
    }
  }

  _remove(id) {
    this.boardDrags.get(id)?.destroy();
    this.boardDrags.delete(id);
    this.boardEls.get(id)?.remove();
    this.boardEls.delete(id);
    if (this.selectedId === id) this.setSelected(null);
  }

  _sync(deck) {
    const el = this.boardEls.get(deck.id);
    syncDeckBoard(el, deck, (pid) => this._portraitUrl(pid, deck.id));
    setBoardEditable(el, this.editable);
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
        for (const d of this.model.decks.values()) {
          if (d.generals.some((g) => g.portraitId === portraitId)) this._sync(d);
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

  /** 겹침 판정·스냅·전체보기에 쓰는 사각형들(크기는 DOM 실측, 줌과 무관한 CSS px). */
  rects() {
    const out = [];
    for (const deck of this.model.decks.values()) {
      const el = this.boardEls.get(deck.id);
      if (el) out.push({ id: deck.id, x: deck.x, y: deck.y, width: el.offsetWidth, height: el.offsetHeight });
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

  /** 새 덱 필드 크기 — 아직 하나도 없으면 임시로 하나 그려서 잰다. */
  measureBoardSize() {
    const any = this.boardEls.values().next().value;
    if (any) return { width: any.offsetWidth, height: any.offsetHeight };
    return { width: 552, height: 900 };
  }

  // ---------- 드래그(헤더로만) ----------

  _attachDrag(id, el) {
    const header = el.querySelector(".deck-header");
    const drag = new DragController(header, {
      // 입력칸·셀렉트·버튼 위에서는 드래그를 시작하지 않는다(글자 선택·클릭이 돼야 함).
      filter: (e) => this.editable && !e.target.closest("input, select, textarea, button, label"),
      onDragStart: () => this._beginDrag(id),
      onDragMove: (dx, dy, e) => this._moveDrag(dx / this.camera.scale, dy / this.camera.scale, e),
      onDragEnd: (e) => this._endDrag(e),
    });
    this.boardDrags.set(id, drag);
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
    this._drag = {
      id, startX: deck.x, startY: deck.y, dx: 0, dy: 0,
      width: el.offsetWidth, height: el.offsetHeight,
    };
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
    const others = this.rects().filter((r) => r.id !== g.id);
    const me = { id: g.id, width: g.width, height: g.height };
    const snapped = computeRectSnap(others, g.startX + g.dx, g.startY + g.dy, me, {
      threshold: SNAP_THRESHOLD_PX / this.camera.scale,
      colSpacing: g.width + DECK_GAP,
      rowSpacing: g.height + DECK_GAP,
    });
    let nx = snapped.x, ny = snapped.y;
    let { guideX, guideY } = snapped;
    // 다른 덱 필드와 겹치는 자리로는 못 간다 — 한 축만 막히면 그 축만 멈춰서 벽을 타고 미끄러지듯,
    // 둘 다 막히면 그 자리에 멈춘다(가계도 필드와 같은 규칙). 단, 이미 겹쳐 있는 상태(예: 다른
    // 기기에서 가져온 데이터)라면 막지 않는다 — 그래야 겹친 덱을 빼낼 수 있다.
    const collides = (x, y) => rectCollides(others, g.width, g.height, x, y, null);
    if (collides(nx, ny) && !collides(deck.x, deck.y)) {
      const xOk = !collides(nx, deck.y);
      const yOk = !collides(deck.x, ny);
      if (xOk && !yOk) { ny = deck.y; guideY = null; }
      else if (yOk && !xOk) { nx = deck.x; guideX = null; }
      else { nx = deck.x; ny = deck.y; guideX = null; guideY = null; }
    }
    // 드래그 중엔 모델 이벤트(=실행취소 스냅샷·자동저장)를 쏘지 않고 직접 옮긴다 — 끝날 때 한 번만 반영.
    deck.x = nx;
    deck.y = ny;
    positionDeckBoard(this.boardEls.get(g.id), deck);
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
      deck.y = g.startY;
      this.model.removeDeck(g.id);
      return;
    }
    const { x, y } = deck;
    deck.x = g.startX;
    deck.y = g.startY;
    if (x !== g.startX || y !== g.startY) this.model.updateDeck(g.id, { x, y });
    else positionDeckBoard(el, deck);
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
