import { CATALOG } from "../catalog.js";

/** "arts"나 "equipmentOptions.opt1"처럼 점으로 이은 카탈로그 목록 경로 → [{ id, name }]. */
export function catalogList(catalogKey) {
  return catalogKey.split(".").reduce((o, k) => o?.[k], CATALOG) || [];
}

/** id의 표시 이름. 카탈로그에서 사라진 id면 "(삭제된 항목: id)". */
export function catalogName(catalogKey, id) {
  return catalogList(catalogKey).find((item) => item.id === id)?.name ?? `(삭제된 항목: ${id})`;
}

/** catalogKey(CATALOG의 목록 경로)의 선택지로 채운 <select> HTML. 맨 위는 placeholder(값 없음),
 * extras([{ id, name }])는 카탈로그 뒤에 덧붙는 고정 선택지(예: 속성치의 "텍스트박스"). */
export function selectHTML(catalogKey, path, { extraClass = "", placeholder = "— 선택 —", extras = [] } = {}) {
  const options = [...catalogList(catalogKey), ...extras]
    .map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`)
    .join("");
  return `<select class="catalog-select ${extraClass}" data-path="${path}" data-catalog="${catalogKey}">
    <option value="">${esc(placeholder)}</option>${options}
  </select>`;
}

/** 값을 맞춘다. 카탈로그에서 사라진 id가 저장돼 있으면 "(삭제된 항목: id)" 선택지를 임시로
 * 붙여서 값을 잃지 않게 한다(다른 걸 고르면 그 임시 선택지는 다음 동기화 때 사라진다). */
export function syncSelect(select, value) {
  const stale = select.querySelector("option[data-stale]");
  const v = value ?? "";
  const known = [...select.options].some((o) => o.value === v && !("stale" in o.dataset));
  if (known) {
    stale?.remove();
  } else if (!stale || stale.value !== v) {
    stale?.remove();
    const opt = document.createElement("option");
    opt.value = v;
    opt.dataset.stale = "";
    opt.textContent = `(삭제된 항목: ${v})`;
    select.append(opt);
  }
  if (select.value !== v) select.value = v;
  select.classList.toggle("empty", v === "");
  // 칸이 좁아 이름이 잘려도 마우스를 올리면 전체 이름이 보이게.
  select.title = v === "" ? "" : select.selectedOptions[0]?.textContent || "";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
