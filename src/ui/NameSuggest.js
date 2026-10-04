/**
 * 장수·전법 이름 자동완성 — 입력칸 바로 아래에 뜨는 후보 목록.
 *
 * 브라우저 기본 <datalist>는 한글 조합 중(마지막 글자를 치는 중)에는 후보를 안 띄워서, 글자를 치고
 * 칸을 다시 눌러야 목록이 떴다. 그래서 직접 그린다 — data-suggest="general|tactic"을 든 입력칸을
 * 누르거나 글자를 칠 때마다 getNames(종류)로 이름들을 받아, 지금 친 글자가 들어간 것만 보여 준다
 * (그 글자로 시작하는 것 먼저). 지금 칸의 값과 똑같은 이름은 빼서, 치고 있는 글자가 자기 후보로 뜨지 않게.
 * ↑↓로 고르고 Enter(또는 클릭)로 넣고, Esc로 닫는다.
 */
export function initNameSuggest(getNames) {
  const box = document.createElement("div");
  box.className = "name-suggest";
  box.hidden = true;
  box.setAttribute("role", "listbox");
  document.body.append(box);

  let input = null; // 목록이 붙어 있는 입력칸
  let items = [];
  let active = -1;
  let picking = false;

  const norm = (s) => String(s ?? "").trim().toLowerCase();

  function close() {
    box.hidden = true;
    box.replaceChildren();
    input = null;
    items = [];
    active = -1;
  }

  function open(el) {
    if (el.readOnly || el.disabled) return close();
    const q = norm(el.value);
    const names = getNames(el.dataset.suggest).filter((n) => norm(n) !== q && norm(n).includes(q));
    const starts = names.filter((n) => norm(n).startsWith(q));
    items = [...starts, ...names.filter((n) => !norm(n).startsWith(q))];
    if (!items.length) return close();
    input = el;
    active = -1;
    box.replaceChildren(...items.map((n, i) => {
      const row = document.createElement("div");
      row.className = "name-suggest-item";
      row.setAttribute("role", "option");
      row.dataset.index = String(i);
      row.textContent = n;
      return row;
    }));
    box.hidden = false;
    box.scrollTop = 0;
    place();
  }

  // 입력칸 아래(자리가 모자라면 위)에 붙인다 — 화면 좌표(position:fixed)라 캔버스 확대와 상관없다.
  function place() {
    const r = input.getBoundingClientRect();
    box.style.minWidth = `${Math.max(r.width, 120)}px`;
    const h = box.offsetHeight;
    const below = window.innerHeight - r.bottom;
    const top = below < h + 8 && r.top > below ? r.top - h - 2 : r.bottom + 2;
    box.style.top = `${Math.max(4, top)}px`;
    box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4))}px`;
  }

  function setActive(i, scroll = true) {
    box.children[active]?.classList.remove("active");
    active = i;
    const row = box.children[active];
    row?.classList.add("active");
    if (scroll) row?.scrollIntoView({ block: "nearest" });
  }

  function pick(i) {
    const el = input;
    const name = items[i];
    close();
    if (!el || name == null) return;
    el.value = name;
    // 입력칸에 직접 친 것처럼 input 이벤트를 보내서 덱/리스트가 모델에 쓰게 한다.
    picking = true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    picking = false;
  }

  document.addEventListener("input", (e) => {
    if (picking || !e.target.matches?.("[data-suggest]")) return;
    open(e.target);
  });
  document.addEventListener("click", (e) => {
    if (e.target.matches?.("[data-suggest]")) {
      if (e.target !== input) open(e.target);
    } else if (!box.contains(e.target)) close();
  });
  document.addEventListener("focusout", (e) => {
    if (e.target === input) close();
  });
  // 캔버스를 끌거나 확대하면 입력칸이 움직이니 닫는다(목록 안에서 굴리는 건 그대로).
  document.addEventListener("wheel", (e) => {
    if (input && !box.contains(e.target)) close();
  }, { passive: true, capture: true });
  window.addEventListener("resize", close);

  // 캡처 단계 — 목록이 열려 있을 때 ↑↓/Enter/Esc는 여기서 처리하고 다른 단축키로 안 넘긴다.
  document.addEventListener("keydown", (e) => {
    if (!input || e.target !== input || e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((active + step + items.length + (active < 0 && step < 0 ? 1 : 0)) % items.length);
    } else if (e.key === "Enter" && active >= 0) {
      pick(active);
    } else if (e.key === "Escape") {
      close();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // 누를 때 입력칸 포커스가 빠지지 않게(focusout으로 닫히지 않게) mousedown 기본 동작을 막는다.
  box.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const row = e.target.closest(".name-suggest-item");
    if (row) pick(Number(row.dataset.index));
  });
  box.addEventListener("mousemove", (e) => {
    const row = e.target.closest(".name-suggest-item");
    if (row && Number(row.dataset.index) !== active) setActive(Number(row.dataset.index), false);
  });
}
