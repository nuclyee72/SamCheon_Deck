import { TACTIC_COUNT, ART_COUNT, GEAR_OPTION_KEYS, STAT_TEXT, ART_TEXT } from "../core/DeckModel.js";
import { createTacticBox, syncTacticBox } from "./TacticBox.js";
import { selectHTML, syncSelect, catalogList, catalogName } from "./selects.js";

const DEFAULT_AVATAR = "assets/default-avatar.svg";

/** 장수 카드 하나(덱 양식의 한 열). gi = 장수 번호(0~2). */
export function createGeneralCard(gi) {
  const base = `generals.${gi}`;
  const el = document.createElement("section");
  el.className = "general-card";
  el.dataset.general = String(gi);
  el.innerHTML = `
    <div class="general-top">
      <div class="portrait">
        <button type="button" class="portrait-btn" data-act="pick-portrait" title="클릭해서 초상화 선택 · 이미지 파일을 끌어다 놓아도 돼요">
          <img class="portrait-img" src="${DEFAULT_AVATAR}" alt="">
        </button>
        <button type="button" class="tally-badge" data-act="toggle-tally" title="병부 필요 여부" aria-pressed="false">병부</button>
        <button type="button" class="portrait-remove" data-act="remove-portrait" title="초상화 지우기" aria-label="초상화 지우기">×</button>
      </div>
      <div class="general-ident">
        <input type="text" class="general-name" list="dl-general-names" autocomplete="off" data-path="${base}.name" placeholder="장수 ${gi + 1}">
        <div class="troop-row">
          ${selectHTML("troopTypes", `${base}.troopType`, { placeholder: "병종" })}
          ${selectHTML("troopTraditions", `${base}.troopTradition`, { placeholder: "전통" })}
        </div>
      </div>
    </div>

    <div class="general-section" data-section="tactics">
      <h4>전법</h4>
      <div class="tactic-list"></div>
    </div>

    <div class="general-section" data-section="arts">
      <h4>병법</h4>
      <div class="pick-row dup-group">
        ${Array.from({ length: ART_COUNT }, (_, ai) => `
          <div class="art-choice">
            ${selectHTML("arts", `${base}.arts.${ai}`, { placeholder: "—", extras: [{ id: ART_TEXT, name: "고유" }] })}
            <input type="text" class="art-text" data-path="${base}.artTexts.${ai}" placeholder="고유 병법">
          </div>`).join("")}
      </div>
    </div>

    ${gearSectionHTML("장비", "equipmentOptions", `${base}.equipmentOptions`)}
    ${gearSectionHTML("탈것", "mountOptions", `${base}.mountOptions`)}

    <div class="general-section" data-section="stats">
      <h4>속성치</h4>
      <div class="stat-choice">
        ${selectHTML("statOptions", `${base}.statChoice`, { extras: [{ id: STAT_TEXT, name: "텍스트박스" }] })}
        <input type="text" class="stat-text" data-path="${base}.statText" placeholder="직접 입력">
      </div>
    </div>
  `;
  const tacticList = el.querySelector(".tactic-list");
  for (let ti = 0; ti < TACTIC_COUNT; ti++) tacticList.append(createTacticBox(gi, ti));
  return el;
}

/** 장비/탈것 — 옵 줄마다 "고른 추천 칩들 + [+▼]". [+▼]에는 그 옵의 후보(카탈로그 opt1/opt2)만
 * 나오고, 고르면 칩이 하나 늘어난다(개수 제한 없음, 왼쪽부터 추천 순서). 칩 ×로 뺀다.
 * [+▼]는 data-path가 아니라 data-add-path를 들고 있다 — 값을 "설정"하는 게 아니라 목록에 "추가"하는
 * 칸이라서, DeckBoard가 고른 값을 add-gear 동작으로 넘기고 셀렉트는 다시 비운다. */
function gearSectionHTML(title, catalogKey, path) {
  const rows = GEAR_OPTION_KEYS.map((optKey, oi) => `
    <div class="gear-option" data-gear-path="${path}.${oi}" data-catalog="${catalogKey}.${optKey}">
      <span class="gear-option-label">${oi + 1}옵</span>
      <div class="gear-chips">
        <select class="gear-add" data-add-path="${path}.${oi}" title="${oi + 1}옵 추천 추가" aria-label="${title} ${oi + 1}옵 추천 추가">
          <option value="">+</option>
          ${catalogList(`${catalogKey}.${optKey}`).map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}
        </select>
      </div>
    </div>`).join("");
  return `<div class="general-section" data-section="${catalogKey}"><h4>${title}</h4>${rows}</div>`;
}

/** 옵 줄 하나의 칩을 picks(id 배열)에 맞춘다 — 이미 고른 후보는 [+▼]에서 숨긴다. */
function syncGearOption(rowEl, picks) {
  const chipsEl = rowEl.querySelector(".gear-chips");
  const addEl = rowEl.querySelector(".gear-add");
  for (const chip of chipsEl.querySelectorAll(".gear-chip")) chip.remove();
  picks.forEach((id, index) => {
    const chip = document.createElement("span");
    chip.className = "gear-chip";
    const label = document.createElement("span");
    label.textContent = catalogName(rowEl.dataset.catalog, id);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.act = "remove-gear";
    remove.dataset.path = rowEl.dataset.gearPath;
    remove.dataset.index = String(index);
    remove.textContent = "×";
    remove.title = "빼기";
    remove.setAttribute("aria-label", `${label.textContent} 빼기`);
    chip.append(label, remove);
    chipsEl.insertBefore(chip, addEl);
  });
  for (const opt of addEl.options) {
    if (opt.value) opt.hidden = opt.disabled = picks.includes(opt.value);
  }
  addEl.value = "";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** general: 덱의 장수 데이터, portraitUrl: 초상화 objectURL(없으면 null). borrowed: 그 초상화가 이 장수 것이
 * 아니라 이름이 같은 리스트 장수에게서 빌려 온 것(× 지우기 버튼을 숨긴다 — 지울 게 없으니까). */
export function syncGeneralCard(el, general, portraitUrl, { borrowed = false } = {}) {
  setInput(el.querySelector(".general-name"), general.name);

  for (const select of el.querySelectorAll("select[data-path]")) {
    const key = select.dataset.path.split(".").slice(2).join(".");
    syncSelect(select, readPath(general, key));
  }
  for (const rowEl of el.querySelectorAll(".gear-option")) {
    const [, , field, oi] = rowEl.dataset.gearPath.split(".");
    syncGearOption(rowEl, general[field][Number(oi)]);
  }

  // 병법 3개 중 같은 걸 두 번 고르면 그 칸들에 경고 테두리("고유"는 이름이 각자 달라서 제외).
  for (const group of el.querySelectorAll(".dup-group")) {
    const selects = [...group.querySelectorAll("select")];
    for (const select of selects) {
      const v = select.value;
      select.classList.toggle("dup", !!v && v !== ART_TEXT && selects.filter((x) => x.value === v).length > 1);
    }
  }
  el.querySelectorAll(".art-choice").forEach((choice, ai) => {
    setInput(choice.querySelector(".art-text"), general.artTexts[ai]);
    choice.classList.toggle("is-text", general.arts[ai] === ART_TEXT);
  });

  setInput(el.querySelector(".stat-text"), general.statText);
  el.querySelector(".stat-choice").classList.toggle("is-text", general.statChoice === STAT_TEXT);

  const tacticEls = el.querySelectorAll(".tactic");
  general.tactics.forEach((tactic, ti) => {
    setInput(tacticEls[ti].querySelector(".tactic-input"), tactic.text);
    syncTacticBox(tacticEls[ti], tactic);
  });

  const tally = el.querySelector(".tally-badge");
  tally.classList.toggle("on", !!general.needsTally);
  tally.setAttribute("aria-pressed", String(!!general.needsTally));
  tally.title = general.needsTally ? "병부 필요 (클릭해서 해제)" : "병부 불필요 (클릭해서 표시)";

  el.querySelector(".portrait-img").src = portraitUrl || DEFAULT_AVATAR;
  el.querySelector(".portrait").classList.toggle("has-image", !!portraitUrl);
  el.querySelector(".portrait").classList.toggle("borrowed", borrowed);
  el.querySelector(".portrait-btn").title = borrowed
    ? "리스트에 있는 같은 이름 장수의 초상화 · 클릭해서 이 덱만 다른 초상화로 바꾸기"
    : "클릭해서 초상화 선택 · 이미지 파일을 끌어다 놓아도 돼요";
}

function setInput(input, value) {
  if (document.activeElement !== input) input.value = value ?? "";
}

function readPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
