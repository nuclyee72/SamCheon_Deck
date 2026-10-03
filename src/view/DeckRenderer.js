import { DragController } from "../lib/DragController.js";
import { rectCollides, computeRectSnap } from "../lib/fieldSnap.js";
import { createDeckBoard, syncDeckBoard, positionDeckBoard, closeAllTactics, setBoardEditable } from "../ui/DeckBoard.js";
import { createListBoard, syncListBoard } from "../ui/ListBoard.js";
import { deckPortraitIds, generalKey } from "../core/DeckModel.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const SNAP_THRESHOLD_PX = 14; // 가계도 TreeRenderer와 같은 화면 기준 스냅 거리
// 정렬선 외에 "옆 덱에서 이만큼 띄운 자리"에도 스냅(나란히 늘어놓기 편하게). 사이에 관계선·라벨이
// 들어갈 자리가 있게 넉넉히 — 새 덱/복제본을 놓을 때(main.js)도 같은 간격을 쓴다.
export const DECK_GAP = 300;
// 드래그 스냅에만 쓰는 좁은 간격 — 관계선 없이 바짝(조금만 띄워) 붙여 놓고 싶을 때.
const DECK_GAP_NEAR = 30;

/**
 * DeckModel → DOM 동기화 + 덱 필드 드래그(헤더로만)·정렬 스냅·겹침 방지·휴지통 삭제.
 * 덱 필드 크기는 모델에 없고 DOM에서 잰다(양식이 고정이라 사실상 일정함).
 */
export class DeckRenderer {
  constructor({ model, store, decksEl, guidesEl, camera, trashEl, onInput, onAction, onSelect, onMove, onToggleOwned }) {
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
    this.onToggleOwned = onToggleOwned; // 보유 체크 모드에서 리스트 장수·전법 칸을 누를 때(종류, 이름)

    this.boardEls = new Map(); // deckId -> element
    this.boardDrags = new Map(); // deckId -> DragController(헤더)
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

    // 표시 단계·수정/보기 전환마다 "그 화면에서의 덱 y 위치"를 기억해 둔다(키: _layoutKey()) — 많이로
    // 바꿔 밀려 내려간 덱이 적게로 돌아오면 원래 자리로 돌아가게. 사용자가 덱을 옮기거나 더하거나
    // 빼면(전환 때문이 아닌 위치 변화) 기억은 전부 버린다 — 그 뒤로는 지금 자리가 기준.
    this._layoutMemo = new Map(); // layoutKey -> Map(deckId -> y)
    this._layoutBusy = false; // 전환 때문에 덱을 옮기는 중(이때의 위치 변화는 기억을 안 버림)
    this._posSeen = new Map(); // deckId -> "x,y" — 마지막으로 본 위치(위치가 바뀐 update인지 가리기용)

    model.onChange((type, payload) => {
      this._trackLayout(type, payload);
      this._handle(type, payload);
    });
  }

  _trackLayout(type, payload) {
    const posKey = (d) => `${d.x},${d.y}`;
    if (type === "reset") {
      this._layoutMemo.clear();
      this._posSeen = new Map([...this.model.decks.values()].map((d) => [d.id, posKey(d)]));
      return;
    }
    if (type === "deck:remove") {
      this._posSeen.delete(payload);
      if (!this._layoutBusy) this._layoutMemo.clear();
      return;
    }
    if (type !== "deck:add" && type !== "deck:update") return;
    const moved = this._posSeen.get(payload.id) !== posKey(payload);
    this._posSeen.set(payload.id, posKey(payload));
    if (moved && !this._layoutBusy) this._layoutMemo.clear();
  }

  _layoutKey() {
    return `${this.decksEl.dataset.view}|${this.editable ? "edit" : "view"}`;
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
  }

  renderAll() {
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
    const el = deck.kind === "list" ? createListBoard(deck, handlers) : createDeckBoard(deck, handlers);
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

  /** 덱 높이를 바꿀 수 있는 화면 변경(fn)을 적용한다 — 그 결과 길어진 덱이 아래 덱과 겹치면 밀어낸다.
   * 단, 이 화면(표시 단계·수정/보기)을 전에 본 적이 있고 그 뒤로 덱을 옮기지 않았으면, 밀어내는 대신
   * 그때의 자리로 되돌린다 — 그래야 적게→많이→적게처럼 왔다 갔다 해도 배치가 그대로다. */
  changeLayout(fn) {
    const before = this._layoutKey();
    const oldHeights = new Map(this.rects().map((r) => [r.id, r.height]));
    closeAllTactics();
    this._layoutMemo.set(before, new Map([...this.model.decks.values()].map((d) => [d.id, d.y])));
    fn();
    const after = this._layoutKey();
    const memo = after !== before ? this._layoutMemo.get(after) : null;
    const decks = [...this.model.decks.values()];
    this._layoutBusy = true;
    try {
      if (memo && memo.size === decks.length && decks.every((d) => memo.has(d.id))) {
        for (const d of decks) if (d.y !== memo.get(d.id)) this.model.updateDeck(d.id, { y: memo.get(d.id) });
      } else {
        this._resolveGrowth(oldHeights);
      }
    } finally {
      this._layoutBusy = false;
    }
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
    const portraitUrlFor = (pid) => this._portraitUrl(pid, deck.id);
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
   * 칸에 .unowned(빨간 테두리), 장수 3명을 모두 보유한 덱에 .all-owned. 덱의 전법 1(그 장수의 고유 전법)은
   * 장수를 보유했으면 보유로 친다. 미보유 표시는 그 종류(장수/전법)를 하나라도 체크한 사람에게만 —
   * 보유 체크를 안 쓰는 사람에게까지 전부 빨갛게 보이지 않게. */
  _applyOwned(el, deck) {
    const state = (type, name, ownedAnyway = false) => {
      const key = generalKey(name);
      if (!key) return null;
      if (ownedAnyway || this.owned[type].has(key)) return "owned";
      return this.owned[type].size ? "unowned" : null;
    };
    const mark = (node, st) => {
      node.classList.toggle("owned", st === "owned");
      node.classList.toggle("unowned", st === "unowned");
    };
    if (deck.kind === "list") {
      el.querySelectorAll(".list-general").forEach((item, i) => mark(item, state("general", deck.listGenerals[i]?.name)));
      el.querySelectorAll(".list-tactic").forEach((item, i) => mark(item, state("tactic", deck.listTactics[i])));
      return;
    }
    el.querySelectorAll(".general-card").forEach((card, gi) => {
      const g = deck.generals[gi];
      const genState = state("general", g?.name);
      mark(card, genState);
      card.querySelectorAll(".tactic").forEach((tEl, ti) => {
        const t = g?.tactics[ti];
        mark(tEl, state("tactic", t?.text, ti === 0 && genState === "owned"));
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

  /** 겹침 판정·스냅·전체보기에 쓰는 사각형들(크기는 DOM 실측, 줌과 무관한 CSS px).
   * anchorY = 관계선 기준점 높이 — "비고 줄이 다 보일 때(많이/보통)의 장수 초상화 세로 가운데". 적게에서는
   * 비고 줄이 접혀 초상화가 올라가지만 기준점은 그대로 둬서, 표시 단계를 바꿔도 관계선이 안 움직인다. */
  rects() {
    const out = [];
    for (const deck of this.model.decks.values()) {
      const el = this.boardEls.get(deck.id);
      if (!el) continue;
      // 리스트에는 장수 카드가 없으니 헤더(시즌 제목) 높이에 건다.
      const portrait = el.querySelector(".general-card .portrait");
      const anchorEl = portrait || el.querySelector(".deck-header");
      let anchorY = anchorEl ? offsetTopWithin(anchorEl, el) + anchorEl.offsetHeight / 2 : el.offsetHeight / 2;
      if (portrait) anchorY += collapsedNotesHeight(el);
      out.push({ id: deck.id, x: deck.x, y: deck.y, width: el.offsetWidth, height: el.offsetHeight, anchorY });
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

  /** 새 필드 크기(빈 자리 찾기용) — 같은 종류("deck" | "list")가 이미 있으면 그걸 재고, 없으면 대략값. */
  measureBoardSize(kind = "deck") {
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
