/**
 * 전법 입력칸 하나 + 대체 전법 펼치기.
 *
 * - 입력칸 오른쪽 옆에 ▶ 마크(대체 전법이 있으면 개수도 같이 표시).
 * - ▶를 누르면 그 오른쪽으로 대체 전법 목록이 "떠오른다"(position:absolute 오버레이) — 펼쳐도
 *   덱 필드 크기가 그대로라 다른 덱과 겹치거나 밀어낼 일이 없다.
 * - 대체 전법 칸은 전법보다 박스가 좁고 글자가 작다(style.css의 .tactic-alt-input).
 * - 입력칸 오른쪽 끝 "☆ 필수"를 누르면 필수 전법(★)으로 표시된다(tactic.required).
 *
 * 값 변경은 직접 모델에 쓰지 않는다 — 입력칸은 data-path를, 버튼은 data-act를 들고 있어서
 * DeckBoard의 위임 리스너가 한 곳에서 처리한다. 펼침 상태는 화면 상태일 뿐 저장하지 않는다.
 */
export function createTacticBox(gi, ti) {
  const base = `generals.${gi}.tactics.${ti}`;
  const el = document.createElement("div");
  el.className = "tactic";
  el.dataset.tacticPath = base;
  el.innerHTML = `
    <div class="tactic-field">
      <input type="text" class="tactic-input" data-suggest="tactic" autocomplete="off" data-path="${base}.text" placeholder="전법 ${ti + 1}">
      <button type="button" class="tactic-star" data-act="toggle-required" data-path="${base}.required" aria-pressed="false"><span class="tactic-star-icon">☆</span><span class="tactic-star-label">필수</span></button>
    </div>
    <button type="button" class="tactic-toggle" data-act="toggle-alts" title="대체 전법 보기" aria-expanded="false">
      <span class="tactic-toggle-arrow">▶</span><span class="tactic-toggle-count"></span>
    </button>
    <div class="tactic-alts">
      <div class="tactic-alt-list"></div>
      <button type="button" class="tactic-alt-add" data-act="add-alt">+ 대체 전법</button>
    </div>
  `;
  return el;
}

/** tactic: { text, alternatives } — 지금 사용자가 타이핑 중인 칸(focus)은 값을 덮어쓰지 않는다. */
export function syncTacticBox(el, tactic) {
  const base = el.dataset.tacticPath;
  const alts = tactic.alternatives || [];
  const count = el.querySelector(".tactic-toggle-count");
  count.textContent = alts.length ? String(alts.length) : "";
  el.classList.toggle("has-alts", alts.length > 0);

  const star = el.querySelector(".tactic-star");
  el.classList.toggle("required", !!tactic.required);
  star.querySelector(".tactic-star-icon").textContent = tactic.required ? "★" : "☆";
  star.setAttribute("aria-pressed", String(!!tactic.required));
  star.title = tactic.required ? "필수 전법 (클릭해서 해제)" : "필수 전법으로 표시";

  const list = el.querySelector(".tactic-alt-list");
  // 개수가 같으면 값만 맞추고(포커스·커서 유지), 다르면(추가/삭제) 목록을 새로 만든다.
  if (list.children.length !== alts.length) {
    list.replaceChildren(...alts.map((_, ai) => {
      const row = document.createElement("div");
      row.className = "tactic-alt-row";
      row.innerHTML = `
        <input type="text" class="tactic-alt-input" data-suggest="tactic" autocomplete="off" data-path="${base}.alternatives.${ai}" placeholder="대체 전법 ${ai + 1}">
        <button type="button" class="tactic-alt-remove" data-act="remove-alt" data-index="${ai}" title="삭제" aria-label="대체 전법 ${ai + 1} 삭제">×</button>
      `;
      return row;
    }));
  }
  alts.forEach((value, ai) => {
    const input = list.children[ai].querySelector("input");
    if (document.activeElement !== input) input.value = value;
  });
}

export function setTacticOpen(el, open) {
  el.classList.toggle("open", open);
  el.querySelector(".tactic-toggle").setAttribute("aria-expanded", String(open));
  el.querySelector(".tactic-toggle-arrow").textContent = open ? "◀" : "▶";
}
