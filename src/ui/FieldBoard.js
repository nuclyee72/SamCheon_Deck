/**
 * 필드 하나의 DOM — 가계도 메이커(Gagedo)의 필드를 덱 보드로 옮긴 것. 덱·리스트·텍스트 박스를 올려 두는
 * 빈 둥근 사각형 컨테이너다(점선 테두리 + 옅은 배경, ⋯ → 배경색).
 *
 * - 덱·리스트·텍스트 박스를 끌어다 놓을 때 필드에 조금이라도 걸쳐 있으면 그 필드 소속(deck.fieldId), 완전히
 *   밖이면 소속 없음(새로 넣는 덱은 중심이 필드 안일 때).
 * - 필드 크기는 소속된 것들을 감싸는 크기로 저절로 맞춰진다(여백 포함, 덱이 밀리거나 길어져도 따라감).
 *   비어 있을 때만 저장된 크기(모서리 손잡이로 조절)로 보인다.
 * - 필드를 끌면 소속된 것이 같이 움직이고, 휴지통에 놓거나 ⋯ → 삭제하면 같이 지워진다.
 * - 항상 관계선·덱들 밑에 깔린다(#fields-layer) — 필드의 빈 곳을 잡고 끈다.
 * - 헤더(⠿·🔒·⋯)는 필드 왼쪽 위 바깥에 떠 있고, 수정 모드에서 올리거나 선택했을 때만 보인다.
 */
import { syncTint } from "./DeckBoard.js";

export function createFieldBoard(deck, { onAction }) {
  const el = document.createElement("div");
  el.className = "deck-board field-board";
  el.dataset.id = deck.id;
  el.innerHTML = `
    <header class="deck-header float-header">
      <span class="deck-grip" title="잡고 끌어서 옮기기(위에 올린 덱도 같이)" aria-hidden="true">⠿</span>
      <span class="deck-lock-mark" title="위치 잠김" aria-hidden="true">🔒</span>
      <button type="button" class="deck-menu-btn" data-act="menu" title="필드 메뉴" aria-label="필드 메뉴">⋯</button>
    </header>
    <div class="box-resize box-resize-tl" data-corner="tl" title="끌어서 필드 크기 조절(오른쪽 아래는 고정)" aria-hidden="true"></div>
    <div class="box-resize box-resize-br" data-corner="br" title="끌어서 필드 크기 조절" aria-hidden="true"></div>
  `;
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) onAction(btn.dataset.act, { button: btn });
  });
  return el;
}

/** 위치·크기는 DeckRenderer가(소속 덱에 맞춘 크기라서) — 여기서는 잠금·배경색만. */
export function syncFieldBoard(el, deck) {
  el.classList.toggle("locked", !!deck.locked);
  syncTint(el, deck);
}
