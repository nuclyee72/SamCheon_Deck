/**
 * 리스트 템플릿 필드 하나의 DOM — 헤더(드래그 손잡이·시즌 제목·메뉴) + 장수 목록 + 전법 목록.
 * 목록은 한 줄에 6칸씩, 맨 끝 "+" 칸으로 개수 제한 없이 늘린다(덱 높이가 늘면 아래 덱은
 * DeckRenderer가 밀어낸다).
 *
 * 덱 양식(DeckBoard)과 같은 규칙으로 값은 직접 모델에 쓰지 않는다 — 입력칸은 data-path를, 버튼은
 * data-act를 들고 있고 onInput(path, value) / onAction(act, ctx)으로 넘긴다. 장수/전법 칸을 누르면
 * onHighlight("general" | "tactic", 이름)로 같은 이름의 장수/전법을 보드 전체(덱·다른 리스트)에서
 * 강조한다 — 보기 모드에서도 되어야 해서 onAction과 따로 둔다.
 */
const DEFAULT_AVATAR = "assets/default-avatar.svg";

export function createListBoard(deck, { onInput, onAction, onHighlight }) {
  const el = document.createElement("div");
  el.className = "deck-board list-board";
  el.dataset.id = deck.id;
  el.innerHTML = `
    <header class="deck-header">
      <span class="deck-grip" title="잡고 끌어서 옮기기" aria-hidden="true">⠿</span>
      <input type="text" class="deck-name list-season" data-path="season" placeholder="시즌">
      <span class="deck-lock-mark" title="위치 잠김" aria-hidden="true">🔒</span>
      <button type="button" class="deck-menu-btn" data-act="menu" title="리스트 메뉴" aria-label="리스트 메뉴">⋯</button>
    </header>
    <div class="list-section" data-section="generals">
      <div class="list-grid list-generals">
        <button type="button" class="list-add" data-act="list-add" data-path="listGenerals" title="장수 추가" aria-label="장수 추가">+</button>
      </div>
    </div>
    <div class="list-section" data-section="tactics">
      <div class="list-grid list-tactics">
        <button type="button" class="list-add" data-act="list-add" data-path="listTactics" title="전법 추가" aria-label="전법 추가">+</button>
      </div>
    </div>
  `;

  el.addEventListener("input", (e) => {
    const target = e.target.closest("[data-path]");
    if (target && target.matches("input")) onInput(target.dataset.path, target.value);
  });

  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) {
      const act = btn.dataset.act;
      onAction(act, {
        path: btn.dataset.path ?? null,
        index: btn.dataset.index != null ? Number(btn.dataset.index) : null,
        button: btn,
      });
      // 방금 추가된 칸에 바로 입력할 수 있게 — 목록은 모델 이벤트로 동기적으로 다시 그려진다.
      if (act === "list-add") btn.parentElement.querySelector(".list-item:last-of-type input")?.focus();
      // 초상화 고르기는 장수 칸 강조도 같이(아래로 내려간다). 나머지 버튼은 여기까지.
      if (act !== "pick-portrait") return;
    }
    const item = e.target.closest(".list-general, .list-tactic");
    if (!item) return;
    const type = item.classList.contains("list-general") ? "general" : "tactic";
    onHighlight(type, item.querySelector("input").value, { typing: !!e.target.closest("input") });
  });

  // 장수 칸 초상화에 이미지 파일을 끌어다 놓기
  el.addEventListener("dragover", (e) => {
    if (e.target.closest(".portrait") && [...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) e.preventDefault();
  });
  el.addEventListener("drop", (e) => {
    const btn = e.target.closest(".portrait")?.querySelector(".portrait-btn");
    if (!btn) return;
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    onAction("drop-portrait", { path: btn.dataset.path, file });
  });

  return el;
}

/** portraitUrlFor(portraitId) → objectURL 또는 null. 지금 타이핑 중인 칸(focus)은 값을 덮어쓰지 않는다. */
export function syncListBoard(el, deck, portraitUrlFor) {
  setInput(el.querySelector(".list-season"), deck.season);
  el.classList.toggle("locked", !!deck.locked);

  const gensEl = el.querySelector(".list-generals");
  syncItems(gensEl, deck.listGenerals.length, (i) => {
    const item = document.createElement("div");
    item.className = "list-item list-general";
    item.innerHTML = `
      <div class="portrait">
        <button type="button" class="portrait-btn" data-act="pick-portrait" data-path="listGenerals.${i}.portraitId" title="클릭해서 초상화 선택 · 이미지 파일을 끌어다 놓아도 돼요">
          <img class="portrait-img" src="${DEFAULT_AVATAR}" alt="">
        </button>
        <button type="button" class="portrait-remove" data-act="remove-portrait" data-path="listGenerals.${i}.portraitId" title="초상화 지우기" aria-label="초상화 지우기">×</button>
      </div>
      <input type="text" class="list-general-name" list="dl-general-names" autocomplete="off" data-path="listGenerals.${i}.name" placeholder="장수">
      <button type="button" class="list-item-remove" data-act="list-remove" data-path="listGenerals" data-index="${i}" title="빼기" aria-label="장수 ${i + 1} 빼기">×</button>
    `;
    return item;
  });
  deck.listGenerals.forEach((g, i) => {
    const item = gensEl.children[i];
    setInput(item.querySelector("input"), g.name);
    const url = g.portraitId ? portraitUrlFor(g.portraitId) : null;
    item.querySelector(".portrait-img").src = url || DEFAULT_AVATAR;
    item.querySelector(".portrait").classList.toggle("has-image", !!url);
  });

  const tacticsEl = el.querySelector(".list-tactics");
  syncItems(tacticsEl, deck.listTactics.length, (i) => {
    const item = document.createElement("div");
    item.className = "list-item list-tactic";
    item.innerHTML = `
      <input type="text" class="list-tactic-name" list="dl-tactic-names" autocomplete="off" data-path="listTactics.${i}" placeholder="전법">
      <button type="button" class="list-item-remove" data-act="list-remove" data-path="listTactics" data-index="${i}" title="빼기" aria-label="전법 ${i + 1} 빼기">×</button>
    `;
    return item;
  });
  deck.listTactics.forEach((t, i) => setInput(tacticsEl.children[i].querySelector("input"), t));
}

/** 목록 칸 개수가 바뀌었을 때만(추가/삭제) 칸을 새로 만든다 — 맨 끝 "+" 칸은 그대로 둔다. */
function syncItems(gridEl, count, make) {
  const addBtn = gridEl.querySelector(".list-add");
  if (gridEl.querySelectorAll(".list-item").length === count) return;
  gridEl.replaceChildren(...Array.from({ length: count }, (_, i) => make(i)), addBtn);
}

function setInput(input, value) {
  if (document.activeElement !== input) input.value = value ?? "";
}
