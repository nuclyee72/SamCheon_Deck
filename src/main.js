import { Camera } from "./lib/Camera.js";
import { DragController } from "./lib/DragController.js";
import { UndoManager } from "./lib/UndoManager.js";
import { ImageCropEditor } from "./lib/ImageCropEditor.js";
import { uuid } from "./lib/uuid.js";
import { findFreeRectSpot } from "./lib/fieldSnap.js";
import { DeckModel, cloneDeckContent } from "./core/DeckModel.js";
import { DeckStore, imagesToDataURLs, dataURLsToImages, EXPORT_VERSION } from "./core/DeckStore.js";
import { DeckRenderer } from "./view/DeckRenderer.js";
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

const DECK_GAP = 40; // 새 덱/복제본을 놓을 때 옆 덱과 띄우는 간격

const model = new DeckModel();
const store = new DeckStore();
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
  addDeck: () => {
    if (uiMode === "view") return;
    const deck = placeDeck({});
    renderer.setSelected(deck.id);
    renderer.boardEls.get(deck.id)?.querySelector(".deck-name")?.focus();
  },
  insertTemplate,
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
  uiMode = mode === "view" ? "view" : "edit";
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
  const from = model.decks.get(rel.fromId)?.name || "이름 없는 덱";
  const to = model.decks.get(rel.toId)?.name || "이름 없는 덱";
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

/** content를 가진 새 덱을 (기본: 화면 가운데) 다른 덱과 안 겹치는 가장 가까운 자리에 놓는다. */
function placeDeck(content, near = null) {
  const { width, height } = renderer.measureBoardSize();
  let x, y;
  if (near) {
    ({ x, y } = near);
  } else {
    const c = viewportCenterWorld();
    x = c.x - width / 2;
    y = c.y - height / 2;
  }
  const spot = findFreeRectSpot(renderer.rects(), width, height, x, y, DECK_GAP);
  const deck = model.addDeck(content, spot);
  ensureDeckVisible(deck);
  return deck;
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
    (uiMode === "view" && !e.target.closest(".tactic-toggle, .tactic-alts, .deck-notes")),
  onDragStart: () => camera.setTransforming(true),
  onDragMove: (dx, dy) => camera.pan(dx, dy),
  onDragEnd: () => camera.setTransforming(false),
  onClick: () => {
    renderer.setSelected(null);
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
let portraitTarget = null; // { deckId, gi } — 파일 선택창이 열려 있는 동안 어느 장수 칸인지

function handleDeckAction(deckId, act, ctx) {
  if (act === "menu") return openDeckMenu(deckId, ctx.button);
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
  if (act === "pick-portrait") {
    portraitTarget = { deckId, gi: ctx.gi };
    portraitFileEl.click();
    return;
  }
  if (act === "drop-portrait") return setPortraitFromFile(deckId, ctx.gi, ctx.file);
  if (act === "remove-portrait") {
    // Blob 자체는 지우지 않는다 — 복제본·템플릿·실행취소가 같은 portraitId를 가리키고 있을 수 있다.
    return model.setPath(deckId, `generals.${ctx.gi}.portraitId`, null);
  }
}

portraitFileEl.addEventListener("change", () => {
  const file = portraitFileEl.files[0];
  portraitFileEl.value = "";
  const target = portraitTarget;
  portraitTarget = null;
  if (file && target) setPortraitFromFile(target.deckId, target.gi, file);
});

async function setPortraitFromFile(deckId, gi, file) {
  const blob = await cropEditor.open(file);
  if (!blob || !model.decks.has(deckId)) return;
  const id = uuid();
  await store.putImage(id, blob);
  renderer.cachePortrait(id, blob);
  model.setPath(deckId, `generals.${gi}.portraitId`, id);
}

// ---------- 덱 ⋯ 메뉴 ----------
let menuDeckId = null;

function openDeckMenu(deckId, button) {
  const deck = model.decks.get(deckId);
  if (!deck) return;
  if (menuDeckId === deckId && !deckMenuEl.hidden) return closeDeckMenu();
  menuDeckId = deckId;
  deckMenuEl.querySelector('[data-menu="toggle-lock"]').textContent = deck.locked ? "위치 잠금 해제" : "위치 잠금";
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
  const copy = placeDeck(content, { x: deck.x + (el?.offsetWidth || 0) + DECK_GAP, y: deck.y });
  renderer.setSelected(copy.id);
}

function deleteDeck(deck) {
  const label = deck.name ? `"${deck.name}" 덱` : "이 덱";
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
  const name = prompt("템플릿 이름을 입력하세요.", deck.name || `덱 템플릿 ${templates.length + 1}`);
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
async function exportBoard() {
  const decks = [...model.decks.values()];
  const images = await imagesToDataURLs(await store.collectImages(decks));
  download(`deck-board-${dateStamp()}.json`, {
    kind: "samguk-deck-board", version: EXPORT_VERSION, exportedAt: new Date().toISOString(),
    decks, relations: [...model.relations.values()], view: model.view, images,
  });
}

async function exportDeck(deck) {
  const images = await imagesToDataURLs(await store.collectImages([deck]));
  download(`deck-${safeFileName(deck.name || "untitled")}.json`, {
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
  const data = await store.loadAll();
  model.loadJSON(data); // "reset" → renderer.renderAll()
  if (model.decks.size) camera.fitToContent(renderer.getBounds(), { animate: false });
  updateEmptyHint();
  toolbar.setSaveState("저장됨");
  refreshTemplates();
}

init();
