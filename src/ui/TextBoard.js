/**
 * 자유 텍스트 박스 하나의 DOM — 가계도 메이커(Gagedo)의 텍스트 박스를 덱 보드 방식으로 옮긴 것.
 *
 * - 상자 크기(width/height)와 글자 크기(fontSize)는 따로 논다. 크기는 선택했을 때 보이는 왼쪽 위·오른쪽
 *   아래 모서리 손잡이로(DeckRenderer가 처리), 글자 크기·배경 켜고 끄기는 ⋯ 메뉴에서.
 * - 상자 아무 데나 잡고 끌면 옮기고, 끌지 않고 누르면 글자 입력(textarea에 포커스). 입력 중이 아닐 때는
 *   textarea가 마우스를 안 받아서(style.css) 끌기와 글자 선택이 헷갈리지 않는다.
 * - 헤더(⠿·🔒·⋯)는 상자 위에 떠 있어서 크기 계산(겹침·스냅·관계선)에 안 들어간다 — 수정 모드에서
 *   마우스를 올리거나 선택했을 때만 보인다.
 *
 * 덱/리스트와 같은 규칙으로 값은 직접 모델에 쓰지 않는다 — textarea는 data-path를, ⋯는 data-act를 들고
 * 있고 onInput(path, value) / onAction(act, ctx)으로 넘긴다.
 */
import { syncTint } from "./DeckBoard.js";

export function createTextBoard(deck, { onInput, onAction }) {
  const el = document.createElement("div");
  el.className = "deck-board text-board";
  el.dataset.id = deck.id;
  el.innerHTML = `
    <header class="deck-header float-header">
      <span class="deck-grip" title="잡고 끌어서 옮기기" aria-hidden="true">⠿</span>
      <span class="deck-lock-mark" title="위치 잠김" aria-hidden="true">🔒</span>
      <button type="button" class="deck-menu-btn" data-act="menu" title="텍스트 박스 메뉴" aria-label="텍스트 박스 메뉴">⋯</button>
    </header>
    <textarea class="text-content" data-path="text" placeholder="텍스트" spellcheck="false"></textarea>
    <div class="box-resize box-resize-tl" data-corner="tl" title="끌어서 상자 크기 조절(오른쪽 아래는 고정)" aria-hidden="true"></div>
    <div class="box-resize box-resize-br" data-corner="br" title="끌어서 상자 크기 조절" aria-hidden="true"></div>
  `;
  const content = el.querySelector(".text-content");

  el.addEventListener("input", (e) => {
    if (e.target === content) onInput("text", content.value);
  });
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) onAction(btn.dataset.act, { button: btn });
  });
  content.addEventListener("focus", () => el.classList.add("editing"));
  content.addEventListener("blur", () => el.classList.remove("editing"));
  // 글자가 상자보다 많아 스크롤되는 동안은 휠을 캔버스 확대로 넘기지 않는다(입력 중일 때만 스크롤 가능).
  el.addEventListener("wheel", (e) => {
    if (!el.classList.contains("editing")) return;
    const canScroll = e.deltaY < 0
      ? content.scrollTop > 0
      : content.scrollTop + content.clientHeight < content.scrollHeight - 1;
    if (canScroll) e.stopPropagation();
  });
  return el;
}

/** 끌지 않고 상자를 눌렀을 때 — 글자 입력을 시작한다(커서는 맨 끝). */
export function focusTextBoard(el) {
  const content = el.querySelector(".text-content");
  if (!content || content.readOnly) return;
  content.focus();
  content.setSelectionRange(content.value.length, content.value.length);
}

export function syncTextBoard(el, deck) {
  const content = el.querySelector(".text-content");
  if (document.activeElement !== content) content.value = deck.text;
  sizeTextBoard(el, deck);
  content.style.fontSize = `${deck.fontSize}px`;
  el.classList.toggle("no-bg", !deck.background);
  el.classList.toggle("locked", !!deck.locked);
  syncTint(el, deck);
}

/** 상자 크기만 — 모서리 손잡이로 끄는 동안(모델 이벤트 없이) DeckRenderer가 직접 부른다. */
export function sizeTextBoard(el, deck) {
  el.style.width = `${deck.width}px`;
  el.style.height = `${deck.height}px`;
}
