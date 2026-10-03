import { GENERAL_COUNT, STAT_TEXT, ART_TEXT, generalKey } from "../core/DeckModel.js";
import { createGeneralCard, syncGeneralCard } from "./GeneralCard.js";
import { setTacticOpen } from "./TacticBox.js";
import { selectHTML, syncSelect, catalogList } from "./selects.js";

/**
 * 덱 필드 하나의 DOM — 헤더(드래그 손잡이·덱 이름·메뉴) + 비고·전형 한 줄 + 장수 3열.
 *
 * 입력은 위임 리스너 하나로 처리한다: data-path가 있는 칸에서 input 이벤트가 나면
 * onInput(path, value), data-act 버튼을 누르면 onAction(act, { path, index, gi, button }).
 * 대체 전법 펼치기/접기는 화면 상태라 여기서 직접 처리한다(모델 안 거침).
 */
export function createDeckBoard(deck, { onInput, onAction }) {
  const el = document.createElement("div");
  el.className = "deck-board";
  el.dataset.id = deck.id;
  el.innerHTML = `
    <header class="deck-header">
      <span class="deck-grip" title="잡고 끌어서 옮기기" aria-hidden="true">⠿</span>
      <input type="text" class="deck-name" data-path="name" placeholder="덱 이름">
      <span class="deck-troops" aria-label="병종 구성"></span>
      <span class="deck-lock-mark" title="위치 잠김" aria-hidden="true">🔒</span>
      <button type="button" class="deck-menu-btn" data-act="menu" title="덱 메뉴" aria-label="덱 메뉴">⋯</button>
    </header>
    <div class="deck-notes-row">
      <textarea class="deck-notes" data-path="notes" rows="2" placeholder="비고 / 가이드"></textarea>
      <label class="deck-formation"><span>전형</span>${selectHTML("formations", "formation")}</label>
    </div>
    <div class="deck-generals"></div>
  `;
  const generalsEl = el.querySelector(".deck-generals");
  for (let gi = 0; gi < GENERAL_COUNT; gi++) generalsEl.append(createGeneralCard(gi));

  el.addEventListener("input", (e) => {
    // 장비/탈것 옵의 [+▼] — 고른 후보를 그 옵 목록에 추가하고 셀렉트는 다시 "+"로.
    const addEl = e.target.closest("[data-add-path]");
    if (addEl) {
      const value = addEl.value;
      addEl.value = "";
      if (value) onAction("add-gear", { path: addEl.dataset.addPath, value });
      return;
    }
    const target = e.target.closest("[data-path]");
    if (!target) return;
    let value = target.value;
    if (target.tagName === "SELECT") value = value || null;
    else if (target.dataset.type === "number") value = value === "" ? null : Number(value);
    onInput(target.dataset.path, value);
    // 속성치에서 "텍스트박스"를 고르면 방금 열린 입력칸으로 바로 커서를 옮긴다.
    if (value === STAT_TEXT && target.closest(".stat-choice")) target.parentElement.querySelector(".stat-text")?.focus();
    // 병법에서 "고유"를 고르면 그 칸 아래 이름 입력칸으로.
    if (value === ART_TEXT && target.closest(".art-choice")) target.parentElement.querySelector(".art-text")?.focus();
  });

  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const tacticEl = btn.closest(".tactic");
    const generalEl = btn.closest(".general-card");
    if (act === "toggle-alts") {
      const open = !tacticEl.classList.contains("open");
      closeAllTactics();
      if (open) openTactic(tacticEl);
      return;
    }
    if (act === "add-alt") {
      onAction(act, { path: `${tacticEl.dataset.tacticPath}.alternatives` });
      // 방금 추가된 칸에 바로 입력할 수 있게 포커스 — 목록은 모델 이벤트로 동기적으로 다시 그려진다.
      tacticEl.querySelector(".tactic-alt-row:last-child input")?.focus();
      return;
    }
    onAction(act, {
      path: btn.dataset.path ?? (tacticEl ? `${tacticEl.dataset.tacticPath}.alternatives` : null),
      index: btn.dataset.index != null ? Number(btn.dataset.index) : null,
      gi: generalEl ? Number(generalEl.dataset.general) : null,
      button: btn,
    });
  });

  // 비고·대체 전법 목록처럼 스크롤되는 곳에서는 휠을 캔버스 줌(Camera, #viewport 리스너)으로
  // 넘기지 않고 그 칸의 스크롤로 쓴다 — 더 스크롤할 데가 없으면 그대로 줌.
  el.addEventListener("wheel", (e) => {
    const scroller = e.target.closest(".deck-notes, .tactic-alt-list");
    if (!scroller) return;
    const canScroll = e.deltaY < 0
      ? scroller.scrollTop > 0
      : scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    if (canScroll) e.stopPropagation();
  });

  // 초상화 칸에 이미지 파일을 끌어다 놓기
  el.addEventListener("dragover", (e) => {
    if (e.target.closest(".portrait") && [...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) e.preventDefault();
  });
  el.addEventListener("drop", (e) => {
    const portrait = e.target.closest(".portrait");
    if (!portrait) return;
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    onAction("drop-portrait", { gi: Number(portrait.closest(".general-card").dataset.general), file });
  });

  return el;
}

/** portraitUrlFor(portraitId) → objectURL 또는 null(아직 못 읽었으면 null, 읽은 뒤 다시 sync됨).
 * listPortraits: 리스트 장수 이름(generalKey) → 초상화 id — 장수 카드에 자기 초상화가 없으면 이름이 같은
 * 리스트 장수의 초상화를 빌려 보여준다. */
export function syncDeckBoard(el, deck, portraitUrlFor, listPortraits = new Map()) {
  const name = el.querySelector(".deck-name");
  if (document.activeElement !== name) name.value = deck.name;
  const notes = el.querySelector(".deck-notes");
  if (document.activeElement !== notes) notes.value = deck.notes;
  syncSelect(el.querySelector(".deck-formation select"), deck.formation);
  syncTroopSummary(el.querySelector(".deck-troops"), deck);
  el.classList.toggle("locked", !!deck.locked);
  syncTint(el, deck);
  el.querySelectorAll(".general-card").forEach((cardEl, gi) => {
    const g = deck.generals[gi];
    const borrowedId = g.portraitId ? null : listPortraits.get(generalKey(g.name)) ?? null;
    const pid = g.portraitId || borrowedId;
    syncGeneralCard(cardEl, g, pid ? portraitUrlFor(pid) : null, { borrowed: !!borrowedId });
  });
}

/** 수정 모드면 입력칸·셀렉트를 쓸 수 있게, 보기 모드면 읽기 전용(셀렉트는 disabled — 생김새는
 * style.css가 그냥 박스처럼 바꾼다). 대체 전법 칸처럼 나중에 새로 생기는 칸도 있어서 sync마다 부른다. */
export function setBoardEditable(el, editable) {
  for (const input of el.querySelectorAll("input, textarea")) input.readOnly = !editable;
  for (const select of el.querySelectorAll("select")) select.disabled = !editable;
}

/** 덱 이름 오른쪽 병종 요약 — 장수 1·2·3의 병종을 카탈로그 short(창/말/활/방)로 "말•창•활"처럼
 * 잇는다. 병종을 안 고른 장수는 "?", 셋 다 안 골랐으면 아예 안 보인다. */
function syncTroopSummary(span, deck) {
  const types = catalogList("troopTypes");
  const picked = deck.generals.map((g) => types.find((t) => t.id === g.troopType));
  const any = deck.generals.some((g) => g.troopType);
  span.hidden = !any;
  span.textContent = any ? picked.map((t) => t?.short || "?").join("•") : "";
  span.title = any ? picked.map((t) => t?.name || "미선택").join(" · ") : "";
}

/** 배경색(deck.tint) — style.css의 .deck-board[data-tint]가 색을 칠한다. 덱·리스트 공용. */
export function syncTint(el, deck) {
  if (deck.tint) el.dataset.tint = deck.tint;
  else delete el.dataset.tint;
}

export function positionDeckBoard(el, deck) {
  el.style.transform = `translate(${deck.x}px, ${deck.y}px)`;
}

function openTactic(tacticEl) {
  setTacticOpen(tacticEl, true);
  // 펼친 목록이 아래쪽 다른 덱 필드 밑에 깔리지 않게 이 덱 필드를 잠시 위로 올린다.
  tacticEl.closest(".deck-board")?.classList.add("has-open-tactic");
}

/** 열린 대체 전법 목록을 전부 닫는다(한 번에 하나만 열림). Esc·바깥 클릭에서도 부른다. */
export function closeAllTactics() {
  for (const t of document.querySelectorAll(".tactic.open")) setTacticOpen(t, false);
  for (const b of document.querySelectorAll(".deck-board.has-open-tactic")) b.classList.remove("has-open-tactic");
}
