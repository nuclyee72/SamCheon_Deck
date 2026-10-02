import { Camera } from "./lib/Camera.js";
import { DragController } from "./lib/DragController.js";
import { UndoManager } from "./lib/UndoManager.js";
import { ImageCropEditor } from "./lib/ImageCropEditor.js";
import { uuid } from "./lib/uuid.js";
import { findFreeRectSpot, rectCollides } from "./lib/fieldSnap.js";
import { DeckModel, cloneDeckContent, emptyListGeneral, deckPortraitIds } from "./core/DeckModel.js";
import { DeckStore, MemoryDeckStore, imagesToDataURLs, dataURLsToImages, EXPORT_VERSION } from "./core/DeckStore.js";
import { DeckRenderer, DECK_GAP } from "./view/DeckRenderer.js";
import { RelationRenderer } from "./view/RelationRenderer.js";
import { CATALOG } from "./catalog.js";
import { COLOR_PRESETS, LINE_STYLE_PRESETS } from "./lib/RelationshipLine.js";
import { Toolbar } from "./ui/Toolbar.js";
import { closeAllTactics } from "./ui/DeckBoard.js";

const viewportEl = document.getElementById("viewport");
const stageEl = document.getElementById("stage");
const decksEl = document.getElementById("decks-layer");
const guidesEl = document.getElementById("lines-layer");
const toolbarEl = document.getElementById("toolbar");
const emptyHintEl = document.getElementById("empty-hint");
const trashEl = document.getElementById("trash-drop");
const deckMenuEl = document.getElementById("deck-menu");
const portraitFileEl = document.getElementById("portrait-file");
const appEl = document.getElementById("app");
const relsEl = document.getElementById("rels-layer");
const relEditorEl = document.getElementById("rel-editor");


// ---------- 공개 보기 / 편집 ----------
// 공개 보기(방문자): 리포지토리에 올린 data/board.json을 읽어 보기 모드로만 보여준다 — 브라우저에 아무것도
// 저장하지 않고(MemoryDeckStore), 수정/보기 전환·💾·템플릿·관계 메뉴도 없다.
// 편집: 주소에 ?edit를 붙이거나 내 컴퓨터(localhost)에서 열 때 — 지금까지처럼 이 브라우저(IndexedDB)에
// 저장하며 고치고, 💾 → "게시용 board.json 저장"으로 받은 파일을 data/board.json에 덮어써 push하면 게시된다.
// (localhost에서 방문자 화면을 미리 보려면 ?public)
const PUBLISHED_URL = "data/board.json";
const urlParams = new URLSearchParams(location.search);
const IS_LOCAL = ["localhost", "127.0.0.1", ""].includes(location.hostname);
const PUBLIC = urlParams.has("public") || (!urlParams.has("edit") && !IS_LOCAL);

const model = new DeckModel();
const store = PUBLIC ? new MemoryDeckStore() : new DeckStore();
const undoMgr = new UndoManager(model);
const cropEditor = new ImageCropEditor(document.getElementById("crop-modal"));

// Camera 생성자가 그 자리에서 onChange를 한 번 부르는데 그땐 아직 relations가 없다(바로 아래에서
// 만들어짐) — let으로 선언만 해두고 optional chaining으로 참조한다(가계도 main.js와 같은 사정).
let relations;
const camera = new Camera(viewportEl, stageEl, {
  onChange: (view) => {
    model.view = view;
    relations?.updateScale();
  },
});

const renderer = new DeckRenderer({
  model, store, decksEl, guidesEl, camera, trashEl,
  onInput: (deckId, path, value) => model.setPath(deckId, path, value),
  onAction: handleDeckAction,
  onMove: () => relations?.refresh(),
});

// DeckRenderer보다 나중에 만들어야 한다 — 모델 변경 때 덱 DOM이 먼저 갱신된 뒤 선 끝점을 잰다.
relations = new RelationRenderer({
  model, layerEl: relsEl, camera, deckRenderer: renderer,
  onClick: (relId, e) => {
    if (uiMode !== "edit") return;
    openRelEditor(relId, e.clientX, e.clientY);
  },
});

const toolbar = new Toolbar(toolbarEl, {
  insertTemplate,
  insertBuiltinTemplate,
  deleteTemplate,
  zoomIn: () => zoomAtCenter(1.25),
  zoomOut: () => zoomAtCenter(1 / 1.25),
  zoomReset: () => camera.resetView(),
  fit: () => camera.fitToContent(renderer.getBounds()),
  undo: () => undoMgr.performUndo(),
  redo: () => undoMgr.performRedo(),
  themeToggle: () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  },
  exportBoard,
  exportPublished,
  loadPublishedBoard,
  import: importFile,
  viewMode: (mode) => applyViewMode(mode),
  uiMode: (mode) => applyUiMode(mode),
  pickRelationTemplate: (id) => startConnect(id),
  cancelConnect: () => exitConnect(),
});
toolbar.setRelationTemplates(CATALOG.relationTemplates);

// ---------- 수정 / 보기 모드 — 이 브라우저에만 기억 ----------
// 보기 모드: 수정용 UI(메뉴·추가·삭제 버튼, 드래그 손잡이 등)를 숨기고 셀렉트·입력칸을 그냥 박스로
// 보여준다(style.css #app[data-ui-mode="view"]). 덱은 못 옮기고, 캔버스는 덱 위에서 끌어도 팬된다.
const UI_MODE_KEY = "deck-ui-mode";
let uiMode = "edit";
function applyUiMode(mode, { remember = true } = {}) {
  uiMode = mode === "view" || PUBLIC ? "view" : "edit";
  renderer.changeLayout(() => {
    appEl.dataset.uiMode = uiMode;
    renderer.setEditable(uiMode === "edit");
  });
  toolbar.setUiMode(uiMode);
  closeDeckMenu();
  closeRelEditor();
  if (uiMode === "view") exitConnect();
  relations.refresh();
  if (remember) {
    try { localStorage.setItem(UI_MODE_KEY, uiMode); } catch { /* 저장 안 돼도 전환은 됨 */ }
  }
}

// ---------- 보기 모드(많이/보통/적게) — 이 브라우저에만 기억 ----------
const VIEW_MODE_KEY = "deck-view-mode";
const VIEW_MODES = ["full", "normal", "compact"];
function applyViewMode(mode) {
  if (!VIEW_MODES.includes(mode)) mode = "full";
  renderer.setViewMode(mode);
  relations.refresh();
  toolbar.setViewMode(mode);
  try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* 저장 안 돼도 전환은 됨 */ }
}
{
  let saved = null;
  try { saved = localStorage.getItem(VIEW_MODE_KEY); } catch { /* ignore */ }
  const mode = VIEW_MODES.includes(saved) ? saved : "full";
  decksEl.dataset.view = mode; // 첫 로드 전이라 덱이 없음 — 밀어내기 계산 없이 표시만 맞춘다
  toolbar.setViewMode(mode);
}

// ---------- 덱끼리 관계선 긋기(연결 모드) ----------
// 툴바 "관계 ▾"에서 관계 템플릿을 고르면 연결 모드 — 시작 덱, 끝 덱을 차례로 누르면 그 템플릿의
// 기본값(화살표 여부·라벨·색·선 종류)으로 관계선이 생긴다. Esc나 "관계" 버튼을 다시 누르면 취소.
let connect = null; // { template, fromId } | null

function startConnect(templateId) {
  const template = CATALOG.relationTemplates.find((t) => t.id === templateId);
  if (!template || uiMode !== "edit") return;
  closeAllTactics();
  closeDeckMenu();
  closeRelEditor();
  renderer.setSelected(null);
  connect = { template, fromId: null };
  viewportEl.classList.add("connect-mode");
  updateConnectStatus();
}

function exitConnect() {
  if (!connect) return;
  if (connect.fromId) renderer.boardEls.get(connect.fromId)?.classList.remove("connect-from");
  connect = null;
  viewportEl.classList.remove("connect-mode");
  toolbar.setConnectStatus(null);
}

function updateConnectStatus() {
  toolbar.setConnectStatus(`${connect.template.name}: ${connect.fromId ? "끝 덱 선택" : "시작 덱 선택"} (취소)`);
}

function pickConnectDeck(deckId) {
  if (!connect.fromId) {
    connect.fromId = deckId;
    renderer.boardEls.get(deckId)?.classList.add("connect-from");
    updateConnectStatus();
    return;
  }
  if (deckId === connect.fromId) return; // 같은 덱을 또 누르면 무시(다른 덱을 골라야 함)
  const t = connect.template;
  model.addRelation({
    fromId: connect.fromId, toId: deckId, type: t.arrow ? "arrow" : "custom", template: t.id,
    label: t.label || "", color: t.color ?? null, lineStyle: t.lineStyle ?? null,
  });
  exitConnect();
}

// 연결 모드에서는 덱을 누르면 입력칸·버튼 대신 "그 덱을 고른 것"으로 처리한다 — 캡처 단계에서 가로채
// 덱 안쪽(입력 포커스, 병부 토글, 헤더 드래그 등)까지 이벤트가 안 내려가게 막는다.
// 고른 직후 따라오는 click도 삼킨다 — 두 번째 덱을 고르면 그 pointerdown에서 연결 모드가 끝나는데,
// 그 뒤 click이 그대로 내려가면 누른 자리의 버튼(병부 토글 등)이 눌려버린다.
let swallowNextClick = false;
decksEl.addEventListener("pointerdown", (e) => {
  if (!connect) return;
  const board = e.target.closest(".deck-board");
  if (!board) return;
  e.preventDefault();
  e.stopPropagation();
  swallowNextClick = true;
  pickConnectDeck(board.dataset.id);
}, true);
decksEl.addEventListener("click", (e) => {
  if (!swallowNextClick) return;
  swallowNextClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);

// ---------- 관계선 편집 창 ----------
let editingRelId = null;

relEditorEl.querySelector(".rel-editor-swatches").append(
  ...[null, ...COLOR_PRESETS].map((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rel-editor-swatch";
    b.dataset.color = c ?? "";
    b.title = c ? c : "기본값";
    if (c) b.style.background = c;
    else b.textContent = "기본";
    return b;
  }),
);
relEditorEl.querySelector(".rel-editor-style").append(
  ...Object.entries(LINE_STYLE_PRESETS).map(([key, { label }]) => new Option(label, key)),
);

function openRelEditor(relId, clientX, clientY) {
  const rel = model.relations.get(relId);
  if (!rel) return;
  editingRelId = relId;
  relations.setSelected(relId);
  renderer.setSelected(null);
  closeDeckMenu();
  syncRelEditor(rel);
  relEditorEl.hidden = false;
  const m = relEditorEl.getBoundingClientRect();
  const margin = 8;
  relEditorEl.style.left = `${Math.max(margin, Math.min(clientX + 12, window.innerWidth - m.width - margin))}px`;
  relEditorEl.style.top = `${Math.max(margin, Math.min(clientY + 12, window.innerHeight - m.height - margin))}px`;
  relEditorEl.querySelector(".rel-editor-label").focus();
}

function closeRelEditor() {
  if (relEditorEl.hidden && !editingRelId) return;
  relEditorEl.hidden = true;
  editingRelId = null;
  relations.setSelected(null);
}

function syncRelEditor(rel) {
  const template = CATALOG.relationTemplates.find((t) => t.id === rel.template);
  const titleOf = (id) => (model.decks.has(id) && deckTitle(model.decks.get(id))) || "이름 없는 덱";
  const from = titleOf(rel.fromId);
  const to = titleOf(rel.toId);
  relEditorEl.querySelector(".rel-editor-title").textContent =
    `${template?.name || (rel.type === "arrow" ? "화살표" : "관계")} · ${from} ${rel.type === "arrow" ? (rel.bidirectional ? "↔" : "→") : "—"} ${to}`;
  const label = relEditorEl.querySelector(".rel-editor-label");
  if (document.activeElement !== label) label.value = rel.label || "";
  for (const sw of relEditorEl.querySelectorAll(".rel-editor-swatch")) {
    sw.classList.toggle("active", (sw.dataset.color || null) === (rel.color || null));
  }
  relEditorEl.querySelector(".rel-editor-style").value = rel.lineStyle || "solid";
  relEditorEl.querySelector(".rel-editor-arrow-row").hidden = rel.type !== "arrow";
  relEditorEl.querySelector(".rel-editor-bidir").checked = !!rel.bidirectional;
}

relEditorEl.querySelector(".rel-editor-label").addEventListener("input", (e) => {
  if (editingRelId) model.updateRelation(editingRelId, { label: e.target.value });
});
relEditorEl.querySelector(".rel-editor-style").addEventListener("change", (e) => {
  if (editingRelId) model.updateRelation(editingRelId, { lineStyle: e.target.value === "solid" ? null : e.target.value });
});
relEditorEl.querySelector(".rel-editor-bidir").addEventListener("change", (e) => {
  if (editingRelId) model.updateRelation(editingRelId, { bidirectional: e.target.checked });
});
relEditorEl.addEventListener("click", (e) => {
  if (!editingRelId) return;
  const sw = e.target.closest(".rel-editor-swatch");
  if (sw) return model.updateRelation(editingRelId, { color: sw.dataset.color || null });
  const act = e.target.closest("[data-rel]")?.dataset.rel;
  if (act === "close") return closeRelEditor();
  if (act === "flip") {
    const rel = model.relations.get(editingRelId);
    return model.updateRelation(editingRelId, { fromId: rel.toId, toId: rel.fromId });
  }
  if (act === "delete") {
    model.removeRelation(editingRelId);
    closeRelEditor();
  }
});
model.onChange((type, payload) => {
  if (!editingRelId) return;
  if (type === "reset" || (type === "relation:remove" && payload === editingRelId)) return closeRelEditor();
  if (type === "relation:update" && payload.id === editingRelId) syncRelEditor(payload);
});

// ---------- 테마 ----------
const THEME_KEY = "gagedo-theme";
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  toolbar.setThemeIcon(theme === "dark");
  const themeMeta = document.getElementById("theme-color-meta");
  if (themeMeta) themeMeta.content = theme === "dark" ? "#1c2028" : "#ffffff";
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 저장 안 돼도 전환은 됨 */ }
}
toolbar.setThemeIcon(document.documentElement.getAttribute("data-theme") === "dark");

// 툴바 실제 높이를 CSS 변수로(가계도 style.css의 사이드바/드롭다운 계산이 이 값을 쓴다).
const syncToolbarHeight = () => {
  document.documentElement.style.setProperty("--toolbar-h", `${toolbarEl.getBoundingClientRect().height}px`);
};
new ResizeObserver(syncToolbarHeight).observe(toolbarEl);
syncToolbarHeight();

function zoomAtCenter(factor) {
  const rect = viewportEl.getBoundingClientRect();
  camera.zoomBy(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function viewportCenterWorld() {
  const rect = viewportEl.getBoundingClientRect();
  return camera.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

/** content를 가진 새 덱(또는 리스트)을 (기본: 화면 가운데) 다른 덱과 안 겹치는 가장 가까운 자리에 놓는다. */
function placeDeck(content, near = null) {
  const { width, height } = renderer.measureBoardSize(content.kind === "list" ? "list" : "deck");
  let x, y;
  if (near) {
    ({ x, y } = near);
  } else {
    const c = viewportCenterWorld();
    x = c.x - width / 2;
    y = c.y - height / 2;
  }
  const spot = findGapSpot(renderer.rects(), width, height, x, y);
  const deck = model.addDeck(content, spot);
  ensureDeckVisible(deck);
  return deck;
}

/** (x, y)에 가장 가까우면서 다른 덱과 DECK_GAP 이상 떨어진 자리 — 후보는 원하는 자리 자체와, 기존 덱의
 * 오른쪽·왼쪽·아래·위로 정확히 DECK_GAP 띄운 자리(위/왼쪽 끝을 그 덱에 맞춤)라서 놓자마자 줄이 맞는다.
 * 그런 자리가 하나도 없으면 겹치지만 않는 아무 빈자리. */
function findGapSpot(rects, width, height, x, y) {
  const g = DECK_GAP;
  // 다른 덱을 사방으로 (간격 - 1)만큼 부풀려서 겹침 검사 — 딱 간격만큼 떨어진 자리는 통과.
  const padded = rects.map((r) => ({ id: r.id, x: r.x - (g - 1), y: r.y - (g - 1), width: r.width + 2 * (g - 1), height: r.height + 2 * (g - 1) }));
  const candidates = [{ x, y }];
  for (const r of rects) {
    candidates.push(
      { x: r.x + r.width + g, y: r.y },
      { x: r.x - g - width, y: r.y },
      { x: r.x, y: r.y + r.height + g },
      { x: r.x, y: r.y - g - height },
    );
  }
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (rectCollides(padded, width, height, c.x, c.y, null)) continue;
    const dist = Math.hypot(c.x - x, c.y - y);
    if (dist < bestDist) { best = c; bestDist = dist; }
  }
  return best || findFreeRectSpot(rects, width, height, x, y, 40);
}

/** 덱이 화면 밖으로 걸쳐 있으면(빈 자리를 찾다 보니 가장자리에 놓인 경우 등) 딱 보일 만큼만 화면을
 * 옮긴다. 덱이 화면보다 크면 왼쪽 위를 맞춘다. */
function ensureDeckVisible(deck) {
  const el = renderer.boardEls.get(deck.id);
  if (!el) return;
  const margin = 16;
  const vp = viewportEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  if (r.width > vp.width - margin * 2 || r.left < vp.left + margin) dx = vp.left + margin - r.left;
  else if (r.right > vp.right - margin) dx = vp.right - margin - r.right;
  if (r.height > vp.height - margin * 2 || r.top < vp.top + margin) dy = vp.top + margin - r.top;
  else if (r.bottom > vp.bottom - margin) dy = vp.bottom - margin - r.bottom;
  if (dx || dy) camera.pan(dx, dy);
}

// ---------- 캔버스 배경 드래그 = 팬 ----------
const backgroundDrag = new DragController(viewportEl, {
  // 보기 모드에서는 덱 위에서 끌어도 팬(덱은 어차피 못 옮김) — 대체 전법 펼치기·비고 스크롤만 예외.
  filter: (e) => (!e.target.closest(".deck-board") && !e.target.closest(".rel-line")) ||
    (uiMode === "view" && !e.target.closest(".tactic-toggle, .tactic-alts, .deck-notes, .list-general, .list-tactic")),
  onDragStart: () => camera.setTransforming(true),
  onDragMove: (dx, dy) => camera.pan(dx, dy),
  onDragEnd: () => camera.setTransforming(false),
  onClick: () => {
    renderer.setSelected(null);
    renderer.setHighlight(null);
    closeDeckMenu();
    closeRelEditor();
  },
});
camera.onPinchStart = () => backgroundDrag.cancelDrag();

// 화면 밖(아래쪽)에 걸친 입력칸에 포커스가 가면 브라우저가 #viewport(overflow:hidden)를 몰래 스크롤해서
// 보이게 만든다 — 그러면 카메라 좌표 계산(스크롤 0 가정)이 어긋나 드래그·클릭 위치가 틀어진다.
// 그 스크롤을 곧바로 되돌리고 같은 양만큼 카메라 팬으로 바꿔서, 포커스된 칸은 보이게 하면서 좌표는 유지한다.
viewportEl.addEventListener("scroll", () => {
  const dx = viewportEl.scrollLeft;
  const dy = viewportEl.scrollTop;
  if (!dx && !dy) return;
  viewportEl.scrollLeft = 0;
  viewportEl.scrollTop = 0;
  camera.pan(-dx, -dy);
});

// ---------- 덱 필드 안의 버튼 동작 ----------
let portraitTarget = null; // { deckId, path } — 파일 선택창이 열려 있는 동안 어느 초상화 칸인지

function handleDeckAction(deckId, act, ctx) {
  if (act === "menu") return openDeckMenu(deckId, ctx.button);
  // 리스트(ListBoard)의 장수/전법 칸 추가·빼기
  if (act === "list-add") {
    const list = model.getPath(deckId, ctx.path) || [];
    return model.setPath(deckId, ctx.path, [...list, ctx.path === "listGenerals" ? emptyListGeneral() : ""]);
  }
  if (act === "list-remove") {
    const list = model.getPath(deckId, ctx.path) || [];
    return model.setPath(deckId, ctx.path, list.filter((_, i) => i !== ctx.index));
  }
  if (act === "add-alt") {
    const list = model.getPath(deckId, ctx.path) || [];
    return model.setPath(deckId, ctx.path, [...list, ""]);
  }
  if (act === "remove-alt") {
    const list = model.getPath(deckId, ctx.path) || [];
    return model.setPath(deckId, ctx.path, list.filter((_, i) => i !== ctx.index));
  }
  if (act === "add-gear") {
    const list = model.getPath(deckId, ctx.path) || [];
    if (list.includes(ctx.value)) return;
    return model.setPath(deckId, ctx.path, [...list, ctx.value]);
  }
  if (act === "remove-gear") {
    const list = model.getPath(deckId, ctx.path) || [];
    return model.setPath(deckId, ctx.path, list.filter((_, i) => i !== ctx.index));
  }
  if (act === "toggle-required") return model.setPath(deckId, ctx.path, !model.getPath(deckId, ctx.path));
  if (act === "toggle-tally") {
    const path = `generals.${ctx.gi}.needsTally`;
    return model.setPath(deckId, path, !model.getPath(deckId, path));
  }
  // 초상화 칸 — 덱 장수 카드는 gi로, 리스트 장수 칸은 path(listGenerals.i.portraitId)로 온다.
  const portraitPath = ctx.path || `generals.${ctx.gi}.portraitId`;
  if (act === "pick-portrait") {
    portraitTarget = { deckId, path: portraitPath };
    portraitFileEl.click();
    return;
  }
  if (act === "drop-portrait") return setPortraitFromFile(deckId, portraitPath, ctx.file);
  if (act === "remove-portrait") {
    // Blob 자체는 지우지 않는다 — 복제본·템플릿·실행취소가 같은 portraitId를 가리키고 있을 수 있다.
    return model.setPath(deckId, portraitPath, null);
  }
}

portraitFileEl.addEventListener("change", () => {
  const file = portraitFileEl.files[0];
  portraitFileEl.value = "";
  const target = portraitTarget;
  portraitTarget = null;
  if (file && target) setPortraitFromFile(target.deckId, target.path, file);
});

async function setPortraitFromFile(deckId, path, file) {
  const blob = await cropEditor.open(file);
  if (!blob || !model.decks.has(deckId)) return;
  const id = uuid();
  await store.putImage(id, blob);
  renderer.cachePortrait(id, blob);
  model.setPath(deckId, path, id);
}

// ---------- 덱 ⋯ 메뉴 ----------
let menuDeckId = null;

function openDeckMenu(deckId, button) {
  const deck = model.decks.get(deckId);
  if (!deck) return;
  if (menuDeckId === deckId && !deckMenuEl.hidden) return closeDeckMenu();
  menuDeckId = deckId;
  deckMenuEl.querySelector('[data-menu="toggle-lock"]').textContent = deck.locked ? "위치 잠금 해제" : "위치 잠금";
  deckMenuEl.querySelector('[data-menu="export-deck"]').textContent = `이 ${deck.kind === "list" ? "리스트" : "덱"} JSON으로 내보내기`;
  deckMenuEl.hidden = false;
  const r = button.getBoundingClientRect();
  const m = deckMenuEl.getBoundingClientRect();
  const margin = 6;
  deckMenuEl.style.left = `${Math.max(margin, Math.min(r.right - m.width, window.innerWidth - m.width - margin))}px`;
  deckMenuEl.style.top = `${Math.min(r.bottom + margin, window.innerHeight - m.height - margin)}px`;
}

function closeDeckMenu() {
  deckMenuEl.hidden = true;
  menuDeckId = null;
}

deckMenuEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-menu]");
  if (!btn) return;
  const deckId = menuDeckId;
  closeDeckMenu();
  const deck = model.decks.get(deckId);
  if (!deck) return;
  const action = btn.dataset.menu;
  if (action === "save-template") await saveTemplate(deck);
  else if (action === "duplicate") duplicateDeck(deck);
  else if (action === "export-deck") await exportDeck(deck);
  else if (action === "toggle-lock") model.updateDeck(deck.id, { locked: !deck.locked });
  else if (action === "delete") deleteDeck(deck);
});

document.addEventListener("pointerdown", (e) => {
  if (!deckMenuEl.hidden && !e.target.closest("#deck-menu, .deck-menu-btn")) closeDeckMenu();
  if (!relEditorEl.hidden && !e.target.closest("#rel-editor, .rel-line")) closeRelEditor();
  // 열린 대체 전법 목록은 그 전법 칸 바깥을 누르면 닫는다.
  if (!e.target.closest(".tactic.open")) closeAllTactics();
});

function duplicateDeck(deck) {
  const el = renderer.boardEls.get(deck.id);
  const content = cloneDeckContent(deck);
  if (content.name) content.name = `${content.name} (복사본)`;
  if (content.season) content.season = `${content.season} (복사본)`;
  const copy = placeDeck(content, { x: deck.x + (el?.offsetWidth || 0) + DECK_GAP, y: deck.y });
  renderer.setSelected(copy.id);
}

/** 덱 이름(리스트면 시즌) — 확인창·템플릿 이름·파일 이름에 쓴다. */
function deckTitle(deck) {
  return (deck.kind === "list" ? deck.season : deck.name) || "";
}

function deleteDeck(deck) {
  const noun = deck.kind === "list" ? "리스트" : "덱";
  const label = deckTitle(deck) ? `"${deckTitle(deck)}" ${noun}` : `이 ${noun}`;
  if (confirm(`${label}을 삭제할까요? (실행취소로 되돌릴 수 있어요)`)) model.removeDeck(deck.id);
}

// ---------- 덱 템플릿(이 브라우저에만 저장) ----------
let templates = [];

async function refreshTemplates() {
  try {
    templates = await store.listTemplates();
  } catch (err) {
    console.error(err);
    templates = [];
  }
  toolbar.setTemplates(templates);
}

async function saveTemplate(deck) {
  const content = cloneDeckContent(deck); // prompt 전에 떠둔다 — 누른 순간의 내용으로 저장
  const name = prompt("템플릿 이름을 입력하세요.", deckTitle(deck) || `${deck.kind === "list" ? "리스트" : "덱"} 템플릿 ${templates.length + 1}`);
  if (name === null) return;
  try {
    // 초상화 Blob 사본도 같이 — 원본 덱을 지우거나 바꿔도 템플릿에서는 계속 보이게.
    const images = await store.collectImages([deck]);
    await store.putTemplate({ id: uuid(), name: name.trim() || "이름 없는 템플릿", createdAt: Date.now(), deck: content, images });
    await refreshTemplates();
    toolbar.setSaveState("템플릿 저장됨");
  } catch (err) {
    console.error(err);
    alert("템플릿을 저장하는 중 문제가 발생했습니다.");
  }
}

async function insertTemplate(id) {
  const template = templates.find((t) => t.id === id);
  if (!template) return;
  try {
    await store.restoreImages(template.images);
  } catch (err) {
    console.error(err);
  }
  const deck = placeDeck(JSON.parse(JSON.stringify(template.deck)));
  renderer.setSelected(deck.id);
}

/** 템플릿 메뉴 맨 위의 기본 템플릿 — "deck"(빈 덱 양식) / "list"(시즌 + 장수 목록 + 전법 목록).
 * 놓은 뒤 제목 칸(덱 이름 / 시즌)에 바로 입력할 수 있게 포커스. */
function insertBuiltinTemplate(kind) {
  if (uiMode === "view" || !["deck", "list"].includes(kind)) return;
  const deck = placeDeck({ kind });
  renderer.setSelected(deck.id);
  renderer.boardEls.get(deck.id)?.querySelector(".deck-name")?.focus();
}

async function deleteTemplate(id) {
  const template = templates.find((t) => t.id === id);
  if (!template || !confirm(`"${template.name}" 템플릿을 삭제할까요?`)) return;
  try {
    await store.deleteTemplate(id);
  } catch (err) {
    console.error(err);
  }
  await refreshTemplates();
}

// ---------- 내보내기 / 가져오기 ----------
async function boardExportData() {
  const decks = [...model.decks.values()];
  const images = await imagesToDataURLs(await store.collectImages(decks));
  return {
    kind: "samguk-deck-board", version: EXPORT_VERSION, exportedAt: new Date().toISOString(),
    decks, relations: [...model.relations.values()], view: model.view, images,
  };
}

async function exportBoard() {
  download(`deck-board-${dateStamp()}.json`, await boardExportData());
}

/** 게시용 — 리포지토리의 data/board.json에 그대로 덮어쓸 파일. 내용은 "보드 전체 내보내기"와 같다. */
async function exportPublished() {
  download("board.json", await boardExportData());
}

/** 게시된 data/board.json을 읽는다 — 초상화는 store에 먼저 넣어 두고 { decks, relations, view }를 돌려준다.
 * 없거나(아직 게시 안 함) 못 읽으면 null. */
async function fetchPublished() {
  try {
    const res = await fetch(PUBLISHED_URL, { cache: "no-cache" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.kind !== "samguk-deck-board") return null;
    await store.restoreImages(await dataURLsToImages(data.images));
    return { decks: data.decks || [], relations: data.relations || [], view: model.view };
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** 💾 → "게시본 불러오기" — 지금 보드를 게시된 보드로 바꾼다(실행취소 가능). */
async function loadPublishedBoard() {
  if (!confirm("지금 보드를 게시된 보드(data/board.json)로 바꿀까요? (실행취소로 되돌릴 수 있어요)")) return;
  const data = await fetchPublished();
  if (!data) return alert("게시된 보드를 불러오지 못했습니다. 아직 게시하지 않았을 수 있어요.");
  model.loadJSON(data);
  camera.fitToContent(renderer.getBounds());
}

async function exportDeck(deck) {
  const images = await imagesToDataURLs(await store.collectImages([deck]));
  download(`deck-${safeFileName(deckTitle(deck) || "untitled")}.json`, {
    kind: "samguk-deck", version: EXPORT_VERSION, exportedAt: new Date().toISOString(),
    deck: cloneDeckContent(deck), images,
  });
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.kind === "samguk-deck-board") {
      if (!confirm("지금 보드를 가져온 보드로 바꿀까요? (실행취소로 되돌릴 수 있어요)")) return;
      await store.restoreImages(await dataURLsToImages(data.images));
      model.loadJSON({ decks: data.decks, relations: data.relations, view: model.view });
      camera.fitToContent(renderer.getBounds());
    } else if (data.kind === "samguk-deck") {
      await store.restoreImages(await dataURLsToImages(data.images));
      const deck = placeDeck(data.deck);
      renderer.setSelected(deck.id);
    } else {
      throw new Error("unknown kind");
    }
  } catch (err) {
    console.error(err);
    alert("파일을 읽는 중 문제가 발생했습니다. 덱 보드에서 내보낸 JSON 파일인지 확인해주세요.");
  }
}

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function safeFileName(s) {
  return s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
}

// ---------- 장수·전법 이름 자동완성 ----------
// 보드에 이미 있는 장수 이름 / 전법 이름을 <datalist>로 모아 입력칸에 후보로 띄운다 — 같은 장수를
// 조금 다르게 적으면 강조(리스트에서 누르기)가 안 맞으니, 이미 쓴 이름을 골라 쓰게.
const generalNamesEl = document.createElement("datalist");
generalNamesEl.id = "dl-general-names";
const tacticNamesEl = document.createElement("datalist");
tacticNamesEl.id = "dl-tactic-names";
document.body.append(generalNamesEl, tacticNamesEl);

function refreshNameSuggestions() {
  const generals = new Set();
  const tactics = new Set();
  const add = (set, v) => { const s = String(v ?? "").trim(); if (s) set.add(s); };
  for (const d of model.decks.values()) {
    if (d.kind === "list") {
      d.listGenerals.forEach((g) => add(generals, g.name));
      d.listTactics.forEach((t) => add(tactics, t));
    } else {
      for (const g of d.generals) {
        add(generals, g.name);
        for (const t of g.tactics) {
          add(tactics, t.text);
          t.alternatives.forEach((a) => add(tactics, a));
        }
      }
    }
  }
  const fill = (el, set) => {
    const values = [...set].sort((a, b) => a.localeCompare(b, "ko"));
    // 바뀐 게 없으면 그대로 둔다(입력 중에 후보 목록이 깜빡이지 않게).
    const sig = values.join("\n");
    if (el.dataset.values === sig) return;
    el.dataset.values = sig;
    el.replaceChildren(...values.map((v) => Object.assign(document.createElement("option"), { value: v })));
  };
  fill(generalNamesEl, generals);
  fill(tacticNamesEl, tactics);
}
let suggestTimer = null;
model.onChange(() => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(refreshNameSuggestions, 300);
});

// ---------- 자동저장 / 빈 화면 안내 ----------
function updateEmptyHint() {
  emptyHintEl.style.display = model.decks.size ? "none" : "flex";
}
model.onChange(updateEmptyHint);

let saveTimer = null;
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await store.saveAll(model);
    toolbar.setSaveState("저장됨");
  } catch (err) {
    console.error(err);
    toolbar.setSaveState("저장 실패");
  }
}
model.onChange(() => {
  if (PUBLIC) return;
  toolbar.setSaveState("저장 중…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
});
// 마지막 수정 후 0.5초 안에 탭을 닫거나 새로고침하면 그 수정이 날아가던 문제 — 페이지가 가려지거나
// 떠나는 순간 기다리던 저장을 곧바로 실행한다.
const flushPendingSave = () => { if (saveTimer) saveNow(); };
window.addEventListener("pagehide", flushPendingSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPendingSave(); });

// ---------- 키보드 ----------
function isTyping(e) {
  return !!e.target.closest?.("input, textarea, select, [contenteditable]");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    renderer.setHighlight(null);
    exitConnect();
    closeRelEditor();
    closeAllTactics();
    closeDeckMenu();
    toolbar.closeMenus();
    return;
  }
  if (uiMode === "view") return; // 보기 모드에서는 실행취소·삭제 단축키도 막는다
  if (isTyping(e)) return; // 입력칸 안에서는 브라우저 기본 동작(글자 실행취소 등)을 그대로 둔다
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    undoMgr.performUndo();
  } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
    e.preventDefault();
    undoMgr.performRedo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && editingRelId) {
    e.preventDefault();
    model.removeRelation(editingRelId);
    closeRelEditor();
  } else if ((e.key === "Delete" || e.key === "Backspace") && renderer.selectedId) {
    const deck = model.decks.get(renderer.selectedId);
    if (deck) {
      e.preventDefault();
      deleteDeck(deck);
    }
  }
});

{
  let savedUi = null;
  try { savedUi = localStorage.getItem(UI_MODE_KEY); } catch { /* ignore */ }
  applyUiMode(savedUi, { remember: false });
}

async function init() {
  if (PUBLIC) {
    appEl.dataset.public = "";
    emptyHintEl.innerHTML = "<p>아직 게시된 보드가 없어요.</p>";
  }
  let data = PUBLIC ? null : await store.loadAll();
  // 공개 보기는 항상 게시본, 편집은 이 브라우저에 저장된 게 하나도 없을 때(처음 쓰는 컴퓨터) 게시본에서 시작.
  if (PUBLIC || !data.decks.length) data = (await fetchPublished()) || data || { decks: [], relations: [] };
  model.loadJSON(data); // "reset" → renderer.renderAll()
  if (model.decks.size) camera.fitToContent(renderer.getBounds(), { animate: false });
  updateEmptyHint();
  toolbar.setSaveState("저장됨");
  if (PUBLIC) return;
  await refreshTemplates();
  pruneUnusedImages();
}

/** 보드의 덱·리스트도, 저장한 템플릿도 안 쓰는 초상화 Blob을 IndexedDB에서 지운다. 초상화를 지우거나
 * 바꿔도 Blob은 남겨 두는데(실행취소·복제본이 같은 id를 가리킬 수 있어서) 그게 계속 쌓이지 않게 —
 * 실행취소 기록이 비어 있는 시작 직후에만 돈다. */
async function pruneUnusedImages() {
  try {
    const keep = new Set();
    for (const d of model.decks.values()) deckPortraitIds(d).forEach((id) => keep.add(id));
    for (const t of templates) {
      Object.keys(t.images || {}).forEach((id) => keep.add(id));
      if (t.deck) deckPortraitIds(t.deck).forEach((id) => keep.add(id));
    }
    const removed = await store.pruneImages(keep);
    if (removed) console.info(`안 쓰는 초상화 ${removed}개를 정리했습니다.`);
  } catch (err) {
    console.error(err);
  }
}

init();
