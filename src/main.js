import { Camera } from "./lib/Camera.js";
import { DragController } from "./lib/DragController.js";
import { UndoManager } from "./lib/UndoManager.js";
import { ImageCropEditor } from "./lib/ImageCropEditor.js";
import { uuid } from "./lib/uuid.js";
import { findFreeRectSpot, rectCollides } from "./lib/fieldSnap.js";
import { DeckModel, cloneDeckContent, emptyListGeneral, deckPortraitIds, DECK_TINTS, DECK_KINDS, generalKey } from "./core/DeckModel.js";
import { DeckStore, MemoryDeckStore, imagesToDataURLs, dataURLsToImages, EXPORT_VERSION } from "./core/DeckStore.js";
import { DeckRenderer, DECK_GAP } from "./view/DeckRenderer.js";
import { RelationRenderer } from "./view/RelationRenderer.js";
import { CATALOG } from "./catalog.js";
import { COLOR_PRESETS, LINE_STYLE_PRESETS } from "./lib/RelationshipLine.js";
import { Toolbar } from "./ui/Toolbar.js";
import { closeAllTactics } from "./ui/DeckBoard.js";
import { initNameSuggest } from "./ui/NameSuggest.js";
import { ImageCapture } from "./ui/ImageCapture.js";

const viewportEl = document.getElementById("viewport");
const stageEl = document.getElementById("stage");
const decksEl = document.getElementById("decks-layer");
const fieldsEl = document.getElementById("fields-layer");
const guidesEl = document.getElementById("lines-layer");
const toolbarEl = document.getElementById("toolbar");
const emptyHintEl = document.getElementById("empty-hint");
const trashEl = document.getElementById("trash-drop");
const deckMenuEl = document.getElementById("deck-menu");
const portraitFileEl = document.getElementById("portrait-file");
const appEl = document.getElementById("app");
const relsEl = document.getElementById("rels-layer");
const relEditorEl = document.getElementById("rel-editor");
const updatedAtEl = document.querySelector("#board-meta .updated-at");


// ---------- 공개 보기 / 편집 ----------
// 공개 보기(방문자): 리포지토리에 올린 data/board.json을 읽어 보기 모드로만 보여준다 — 브라우저에 아무것도
// 저장하지 않고(MemoryDeckStore), 수정/보기 전환·💾·템플릿·관계 메뉴도 없다.
// 편집: 주소에 ?edit를 붙이거나 내 컴퓨터(localhost)에서 열 때 — 지금까지처럼 이 브라우저(IndexedDB)에
// 저장하며 고치고, 💾 → "board.json 저장"으로 받은 파일을 data/board.json에 덮어써 push하면 게시된다.
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
// capture(📷 영역 표시)도 마찬가지.
let relations;
let capture;
const camera = new Camera(viewportEl, stageEl, {
  onChange: (view) => {
    model.view = view;
    relations?.updateScale();
    capture?.updateScale();
  },
});

const renderer = new DeckRenderer({
  model, store, decksEl, fieldsEl, guidesEl, camera, trashEl,
  onInput: (deckId, path, value) => model.setPath(deckId, path, value),
  onAction: handleDeckAction,
  onMove: () => relations?.refresh(),
  onToggleOwned: (type, name) => toggleOwned(type, name),
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
  fit: () => camera.fitToContent(renderer.getBounds()),
  undo: () => undoMgr.performUndo(),
  redo: () => undoMgr.performRedo(),
  themeToggle: () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  },
  exportPublished,
  loadPublished: loadPublishedBoard,
  import: importFile,
  capture: () => (capture.active ? capture.exit() : startCapture()),
  viewMode: (mode) => applyViewMode(mode),
  uiMode: (mode) => applyUiMode(mode),
  pickRelationTemplate: (id) => startConnect(id),
  ownedMode: () => setOwnedMode(!renderer.ownedMode),
  ownedAll: () => setAllOwned(true),
  ownedNone: () => setAllOwned(false),
  cancelConnect: () => exitConnect(),
});
toolbar.setRelationTemplates(CATALOG.relationTemplates);

// ---------- 📷 이미지로 저장(영역 고르기 → PNG) ----------
// 공개 보기에서도 된다. 고르는 동안은 캔버스를 투명 판이 덮어서 덱을 누르면 입력 대신 그 덱 영역을 고른다.
capture = new ImageCapture({
  viewportEl, stageEl, camera, renderer,
  layerEl: document.getElementById("capture-layer"),
  barEl: document.getElementById("capture-bar"),
  onSave: (blob) => downloadBlob(`deck-board-${dateStamp()}.png`, blob),
  onToggle: (on) => toolbar.setCaptureActive(on),
});

function startCapture() {
  // 선택 테두리·열린 메뉴·입력 커서가 사진에 안 찍히게 정리하고 시작한다.
  exitConnect();
  closeDeckMenu();
  closeRelEditor();
  closeAllTactics();
  renderer.setSelected(null);
  document.activeElement?.blur?.();
  capture.start();
}

// ---------- 수정 / 보기 모드 — 이 브라우저에만 기억 ----------
// 보기 모드: 수정용 UI(메뉴·추가·삭제 버튼, 드래그 손잡이 등)를 숨기고 셀렉트·입력칸을 그냥 박스로
// 보여준다(style.css #app[data-ui-mode="view"]). 덱은 못 옮기고, 캔버스는 덱 위에서 끌어도 팬된다.
const UI_MODE_KEY = "deck-ui-mode";
let uiMode = "edit";
/** 보기 모드에서 덱/필드를 눌렀을 때 카운터를 또렷하게 보일 대상 — 그 덱 + 그 덱이 든 필드. */
function counterFocusIds(deckId) {
  const deck = deckId && model.decks.get(deckId);
  if (!deck) return null;
  const ids = new Set([deck.id]);
  if (deck.fieldId && model.decks.get(deck.fieldId)?.kind === "field") ids.add(deck.fieldId);
  return ids;
}

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
  relations.setFocus(null);
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

// ---------- 보유 장수·전법 체크 — 이 브라우저에만 기억(공개 보기에서도) ----------
// 장수/전법 이름(generalKey) 목록이라 보드 데이터·게시본·실행취소와 상관없고, 같은 이름은 어느 리스트·덱에서나
// 같이 보유로 보인다. 보유 체크 모드(툴바 "보유 체크")에서 리스트의 장수·전법 칸을 누르면 켜고 끈다.
const OWNED_KEYS = { general: "deck-owned-generals", tactic: "deck-owned-tactics" };
const owned = { general: new Set(), tactic: new Set() };
for (const [type, key] of Object.entries(OWNED_KEYS)) {
  try { owned[type] = new Set(JSON.parse(localStorage.getItem(key) || "[]").map(generalKey).filter(Boolean)); } catch { /* ignore */ }
}
renderer.setOwned(owned);

function saveOwned() {
  renderer.setOwned(owned);
  for (const [type, key] of Object.entries(OWNED_KEYS)) {
    try { localStorage.setItem(key, JSON.stringify([...owned[type]])); } catch { /* 저장 안 돼도 표시는 됨 */ }
  }
}

/** type: "general" | "tactic" */
function toggleOwned(type, name) {
  const key = generalKey(name);
  if (!key || !owned[type]) return;
  if (owned[type].has(key)) owned[type].delete(key);
  else owned[type].add(key);
  saveOwned();
}

/** 전부 보유 = 보드(리스트·덱)에 있는 장수·전법(대체 전법 포함)을 전부 보유로 / 전부 미보유 = 체크를 전부 해제. */
function setAllOwned(on) {
  if (on) {
    const gens = new Set();
    const tactics = new Set();
    for (const d of model.decks.values()) {
      if (d.kind === "list") {
        d.listGenerals.forEach((g) => gens.add(generalKey(g.name)));
        d.listTactics.forEach((t) => tactics.add(generalKey(t)));
      } else if (d.kind === "deck") {
        for (const g of d.generals) {
          gens.add(generalKey(g.name));
          for (const t of g.tactics) [t.text, ...t.alternatives].forEach((n) => tactics.add(generalKey(n)));
        }
      }
    }
    gens.delete("");
    tactics.delete("");
    if (!confirm(`보드에 있는 장수 ${gens.size}명, 전법 ${tactics.size}개를 전부 보유로 할까요?`)) return;
    gens.forEach((k) => owned.general.add(k));
    tactics.forEach((k) => owned.tactic.add(k));
  } else {
    if (!owned.general.size && !owned.tactic.size) return;
    if (!confirm("보유 체크(장수·전법)를 전부 해제할까요?")) return;
    owned.general.clear();
    owned.tactic.clear();
  }
  saveOwned();
}

function setOwnedMode(on) {
  renderer.ownedMode = on;
  appEl.toggleAttribute("data-owned-mode", on);
  toolbar.setOwnedMode(on);
  if (on) renderer.setHighlight(null);
}

// ---------- 덱끼리 관계선 긋기(연결 모드) ----------
// 툴바 "관계 ▾"에서 관계 템플릿을 고르면 연결 모드 — 시작 덱, 끝 덱을 차례로 누르면 그 템플릿의
// 기본값(화살표 여부·라벨·색·선 종류)으로 관계선이 생긴다. Esc나 "관계" 버튼을 다시 누르면 취소.
let connect = null; // { template, fromId } | null

function startConnect(templateId) {
  const template = CATALOG.relationTemplates.find((t) => t.id === templateId);
  if (!template || uiMode !== "edit") return;
  capture.exit();
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
  toolbar.setConnectStatus(`${connect.template.name}: ${connect.fromId ? "끝 덱·필드 선택" : "시작 덱·필드 선택"} (취소)`);
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

// 연결 모드에서는 덱(필드 포함)을 누르면 입력칸·버튼 대신 "그 덱을 고른 것"으로 처리한다 — 캡처 단계에서
// 가로채 덱 안쪽(입력 포커스, 병부 토글, 헤더·필드 드래그 등)까지 이벤트가 안 내려가게 막는다.
// 고른 직후 따라오는 click도 삼킨다 — 두 번째 덱을 고르면 그 pointerdown에서 연결 모드가 끝나는데,
// 그 뒤 click이 그대로 내려가면 누른 자리의 버튼(병부 토글 등)이 눌려버린다.
let swallowNextClick = false;
for (const layer of [decksEl, fieldsEl]) {
  layer.addEventListener("pointerdown", (e) => {
    if (!connect) return;
    const board = e.target.closest(".deck-board");
    if (!board) return;
    e.preventDefault();
    e.stopPropagation();
    swallowNextClick = true;
    pickConnectDeck(board.dataset.id);
  }, true);
  layer.addEventListener("click", (e) => {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

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
  const titleOf = (id) => {
    const d = model.decks.get(id);
    return (d && deckTitle(d)) || (d?.kind === "field" ? "필드" : `이름 없는 ${d ? kindNoun(d) : "덱"}`);
  };
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

function viewportCenterWorld() {
  const rect = viewportEl.getBoundingClientRect();
  return camera.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

/** content를 가진 새 덱(또는 리스트)을 (기본: 화면 가운데) 다른 덱과 안 겹치는 가장 가까운 자리에 놓는다.
 * 텍스트 박스는 겹쳐도 되는 라벨이라 빈 자리를 찾지 않고 그 자리에 그대로. */
function placeDeck(content, near = null) {
  const isText = content.kind === "text";
  const sized = isText || content.kind === "field"; // 크기를 모델에 들고 있는 종류
  const base = renderer.measureBoardSize(content.kind === "list" || sized ? content.kind : "deck");
  const { width, height } = sized ? { width: content.width ?? base.width, height: content.height ?? base.height } : base;
  let x, y;
  if (near) {
    ({ x, y } = near);
  } else {
    const c = viewportCenterWorld();
    x = c.x - width / 2;
    y = c.y - height / 2;
  }
  // 덱·리스트는 필드 위에도 놓일 수 있으니 필드는 장애물로 안 친다. 새 필드는 덱·다른 필드 전부를 피해서
  // (그래야 놓자마자 엉뚱한 덱을 품지 않는다).
  const obstacles = renderer.rects().filter((r) => content.kind === "field" || r.kind !== "field");
  const spot = isText ? { x: Math.round(x), y: Math.round(y) } : findGapSpot(obstacles, width, height, x, y);
  // 놓인 자리가 필드에 걸치면 그 필드 소속(끌어다 놓을 때와 같은 규칙) — 필드 크기가 그 덱까지 감싸게 늘어난다.
  if (content.kind !== "field") content.fieldId = renderer.fieldOverlapping(spot.x, spot.y, width, height);
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
  // 📷 영역을 고르는 동안은 끌기가 사각형 그리기라 팬하지 않는다.
  filter: (e) => !capture.active && (
    (!e.target.closest(".deck-board") && !e.target.closest(".rel-line")) ||
    (uiMode === "view" && !e.target.closest(".tactic-toggle, .tactic-alts, .deck-notes"))),
  onDragStart: () => camera.setTransforming(true),
  onDragMove: (dx, dy) => camera.pan(dx, dy),
  onDragEnd: () => camera.setTransforming(false),
  onClick: (e) => {
    renderer.setSelected(null);
    // 보기 모드에서 덱/필드를 누르면 그 덱에서 출발하는 카운터 관계선만 또렷하게(덱이면 그 덱이 든 필드 것도),
    // 빈 곳을 누르면 다시 전부 흐리게.
    relations.setFocus(uiMode === "view" ? counterFocusIds(e.target.closest?.(".deck-board")?.dataset.id) : null);
    // 보기 모드에서 리스트 장수/전법 칸을 탭한 경우는 그 칸의 click이 강조를 켜고 끈다 — 여기서 먼저
    // 꺼버리면 같은 칸을 다시 눌러 끄기가 안 된다. (그 칸 위에서 끌면 화면 이동은 그대로 된다)
    if (!e.target.closest?.(".list-general, .list-tactic")) renderer.setHighlight(null);
    closeDeckMenu();
    closeRelEditor();
  },
});
camera.onPinchStart = () => {
  backgroundDrag.cancelDrag();
  capture.cancelDrag();
};

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
  if (act === "toggle-tally" || act === "toggle-yeonui") {
    const path = `generals.${ctx.gi}.${act === "toggle-tally" ? "needsTally" : "yeonui"}`;
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

// 배경색 고르기(기본 + DECK_TINTS) — 누르면 메뉴는 열어둔 채 바로 칠해서 비교해 볼 수 있다.
const tintsEl = deckMenuEl.querySelector(".deck-menu-tints");
for (const tint of [null, ...DECK_TINTS]) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "deck-menu-tint";
  btn.dataset.tint = tint || "";
  btn.title = tint ? "배경색" : "기본 배경";
  btn.setAttribute("aria-label", tint ? `배경색 ${tint}` : "기본 배경");
  tintsEl.append(btn);
}
function syncTintButtons(deck) {
  for (const b of tintsEl.querySelectorAll(".deck-menu-tint")) b.classList.toggle("active", (b.dataset.tint || null) === (deck.tint || null));
}
tintsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".deck-menu-tint");
  const deck = model.decks.get(menuDeckId);
  if (!btn || !deck) return;
  model.updateDeck(deck.id, { tint: btn.dataset.tint || null });
  syncTintButtons(deck);
});

function openDeckMenu(deckId, button) {
  const deck = model.decks.get(deckId);
  if (!deck) return;
  if (menuDeckId === deckId && !deckMenuEl.hidden) return closeDeckMenu();
  menuDeckId = deckId;
  deckMenuEl.querySelector('[data-menu="toggle-lock"]').textContent = deck.locked ? "위치 잠금 해제" : "위치 잠금";
  syncTintButtons(deck);
  syncTextMenu(deck);
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

// 텍스트 박스 전용 — 글자 크기(−/+)는 메뉴를 닫지 않고 바로 반영, 배경 켜고 끄기.
const FONT_STEPS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 120];
function syncTextMenu(deck) {
  const isField = deck.kind === "field";
  deckMenuEl.querySelector('[data-menu="save-template"]').hidden = isField;
  const isText = deck.kind === "text";
  for (const n of deckMenuEl.querySelectorAll("[data-text-only]")) n.hidden = !isText;
  if (!isText) return;
  deckMenuEl.querySelector(".deck-menu-font-size").textContent = `${deck.fontSize}px`;
  deckMenuEl.querySelector('[data-menu="toggle-bg"]').textContent = deck.background ? "배경 끄기 (글자만)" : "배경 켜기";
}
function stepFontSize(size, dir) {
  return dir > 0 ? FONT_STEPS.find((s) => s > size) ?? size : [...FONT_STEPS].reverse().find((s) => s < size) ?? size;
}

deckMenuEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-menu]");
  if (!btn) return;
  if (btn.dataset.menu === "font-down" || btn.dataset.menu === "font-up") {
    const deck = model.decks.get(menuDeckId);
    if (!deck) return;
    model.updateDeck(deck.id, { fontSize: stepFontSize(deck.fontSize, btn.dataset.menu === "font-up" ? 1 : -1) });
    syncTextMenu(deck);
    return;
  }
  const deckId = menuDeckId;
  closeDeckMenu();
  const deck = model.decks.get(deckId);
  if (!deck) return;
  const action = btn.dataset.menu;
  if (action === "save-template") await saveTemplate(deck);
  else if (action === "duplicate") duplicateDeck(deck);
  else if (action === "toggle-lock") model.updateDeck(deck.id, { locked: !deck.locked });
  else if (action === "toggle-bg") model.updateDeck(deck.id, { background: !deck.background });
  else if (action === "delete") deleteDeck(deck);
});

document.addEventListener("pointerdown", (e) => {
  if (!deckMenuEl.hidden && !e.target.closest("#deck-menu, .deck-menu-btn")) closeDeckMenu();
  if (!relEditorEl.hidden && !e.target.closest("#rel-editor, .rel-line")) closeRelEditor();
  // 열린 대체 전법 목록은 그 전법 칸 바깥을 누르면 닫는다.
  if (!e.target.closest(".tactic.open")) closeAllTactics();
});

function duplicateDeck(deck) {
  if (deck.kind === "field") return duplicateField(deck);
  const el = renderer.boardEls.get(deck.id);
  const content = cloneDeckContent(deck);
  if (content.name) content.name = `${content.name} (복사본)`;
  if (content.season) content.season = `${content.season} (복사본)`;
  const near = deck.kind === "text" ? { x: deck.x + 24, y: deck.y + 24 } : { x: deck.x + (el?.offsetWidth || 0) + DECK_GAP, y: deck.y };
  const copy = placeDeck(content, near);
  renderer.setSelected(copy.id);
}

/** 필드 복제 — 소속된 덱·리스트·텍스트 박스까지 통째로, 오른쪽 빈 자리에(같은 배치 그대로). */
function duplicateField(field) {
  const memberIds = renderer.fieldMembers(field.id);
  const rects = renderer.rects();
  const r = renderer.fieldRect(field);
  const spot = findGapSpot(rects, r.width, r.height, r.x + r.width + DECK_GAP, r.y);
  const dx = spot.x - r.x;
  const dy = spot.y - r.y;
  const copy = model.addDeck({ ...cloneDeckContent(field), width: r.width, height: r.height }, spot);
  for (const id of memberIds) {
    const d = model.decks.get(id);
    if (d) model.addDeck({ ...cloneDeckContent(d), fieldId: copy.id }, { x: d.x + dx, y: d.y + dy });
  }
  renderer.setSelected(copy.id);
  ensureDeckVisible(copy);
}

/** 덱 이름(리스트면 시즌, 텍스트 박스면 첫 줄 앞부분) — 확인창·템플릿 이름·파일 이름에 쓴다. */
function deckTitle(deck) {
  if (deck.kind === "text") return deck.text.trim().split("\n")[0].slice(0, 20);
  if (deck.kind === "field") return "";
  return (deck.kind === "list" ? deck.season : deck.name) || "";
}

/** 확인창·메뉴 글자에 쓰는 종류 이름. */
function kindNoun(deck) {
  return { list: "리스트", text: "텍스트 박스", field: "필드" }[deck.kind] || "덱";
}

function deleteDeck(deck) {
  if (deck.kind === "field") {
    // 필드는 소속된 것까지 같이 지운다(Gagedo와 같음, 실행취소 한 번에 전부 돌아옴).
    const memberIds = renderer.fieldMembers(deck.id);
    const msg = memberIds.length
      ? `필드와 그 위의 ${memberIds.length}개(덱·리스트·텍스트 박스)를 같이 삭제할까요? (실행취소로 되돌릴 수 있어요)`
      : "이 필드를 삭제할까요? (실행취소로 되돌릴 수 있어요)";
    if (!confirm(msg)) return;
    for (const id of memberIds) model.removeDeck(id);
    model.removeDeck(deck.id);
    return;
  }
  const noun = kindNoun(deck);
  const label = deckTitle(deck) ? `"${deckTitle(deck)}" ${noun}` : `이 ${noun}`;
  if (confirm(`${label}${noun === "덱" ? "을" : "를"} 삭제할까요? (실행취소로 되돌릴 수 있어요)`)) model.removeDeck(deck.id);
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
  const name = prompt("템플릿 이름을 입력하세요.", deckTitle(deck) || `${kindNoun(deck)} 템플릿 ${templates.length + 1}`);
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

/** 템플릿 메뉴 맨 위의 기본 템플릿 — "deck"(빈 덱 양식) / "list"(시즌 + 장수 목록 + 전법 목록) /
 * "text"(텍스트 박스) / "field"(덱을 올려 두는 빈 필드, 화면 가운데 빈 자리에). 놓은 뒤 제목 칸(덱 이름 / 시즌)에 바로 입력할 수 있게 포커스 — 텍스트 박스는
 * 기본 글자("텍스트")를 통째로 골라 둬서 바로 덮어쓰게. */
function insertBuiltinTemplate(kind) {
  if (uiMode === "view" || !DECK_KINDS.includes(kind)) return;
  const deck = placeDeck({ kind });
  renderer.setSelected(deck.id);
  const el = renderer.boardEls.get(deck.id);
  if (kind === "text") {
    const content = el?.querySelector(".text-content");
    content?.focus();
    content?.select();
  } else if (kind !== "field") {
    el?.querySelector(".deck-name")?.focus();
  }
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

// ---------- board.json 저장 / 가져오기 ----------
async function boardExportData() {
  const decks = [...model.decks.values()];
  const images = await imagesToDataURLs(await store.collectImages(decks));
  return {
    kind: "samguk-deck-board", version: EXPORT_VERSION, exportedAt: new Date().toISOString(),
    updatedAt: model.updatedAt ?? null,
    decks, relations: [...model.relations.values()], view: model.view, images,
  };
}

/** 💾 → "board.json 저장" — 리포지토리의 data/board.json에 그대로 덮어쓰면 게시되고, 그냥 보관하면 백업(가져오기로 복원). */
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
    // 수정일이 없는 예전 게시본은 게시(내보낸) 시각으로.
    const updatedAt = data.updatedAt ?? (data.exportedAt ? Date.parse(data.exportedAt) : null);
    return { decks: data.decks || [], relations: data.relations || [], view: model.view, updatedAt };
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
  setUpdatedAt(data.updatedAt);
  camera.fitToContent(renderer.getBounds());
}

/** 보드 JSON(board.json) 가져오기 — 예전에 "이 덱 JSON으로 내보내기"로 받아 둔 덱 파일도 그대로 받아준다. */
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
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
}

function downloadBlob(filename, blob) {
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

// ---------- 장수·전법 이름 자동완성 ----------
// 보드에 이미 있는 장수 이름 / 전법 이름을 입력칸 아래 후보로 띄운다(ui/NameSuggest.js) — 같은 장수를
// 조금 다르게 적으면 강조(리스트에서 누르기)가 안 맞으니, 이미 쓴 이름을 골라 쓰게.
function boardNames(kind) {
  const names = new Set();
  const add = (v) => { const s = String(v ?? "").trim(); if (s) names.add(s); };
  for (const d of model.decks.values()) {
    if (d.kind === "list") {
      if (kind === "general") d.listGenerals.forEach((g) => add(g.name));
      else d.listTactics.forEach(add);
    } else if (d.kind === "deck") {
      for (const g of d.generals) {
        if (kind === "general") add(g.name);
        else for (const t of g.tactics) [t.text, ...t.alternatives].forEach(add);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, "ko"));
}
initNameSuggest(boardNames);

// ---------- 보드 수정일(화면 오른쪽 아래) ----------
// 처음 불러온 뒤로 보드가 바뀔 때마다(덱 내용·위치·관계선·실행취소 등) 지금 시각으로 — 자동저장과
// 게시용 board.json에 같이 들어가서, 공개 보기에서는 게시된 보드의 마지막 수정일이 보인다.
let boardLoaded = false;
function setUpdatedAt(ts) {
  model.updatedAt = ts ?? null;
  updatedAtEl.hidden = !model.updatedAt;
  if (!model.updatedAt) return;
  const d = new Date(model.updatedAt);
  const pad = (n) => String(n).padStart(2, "0");
  updatedAtEl.textContent = `수정일 ${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}
model.onChange(() => {
  if (boardLoaded && !PUBLIC) setUpdatedAt(Date.now());
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
    capture.exit();
    renderer.setHighlight(null);
    relations.setFocus(null);
    setOwnedMode(false);
    exitConnect();
    closeRelEditor();
    closeAllTactics();
    closeDeckMenu();
    toolbar.closeMenus();
    return;
  }
  if (capture.active && e.key === "Enter" && !isTyping(e)) {
    e.preventDefault();
    capture.save();
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
  setUpdatedAt(data.updatedAt ?? null);
  boardLoaded = true;
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
