import { uuid } from "../lib/uuid.js";

export const GENERAL_COUNT = 3;
export const TACTIC_COUNT = 3;
export const ART_COUNT = 3;
/** 장비/탈것의 옵 줄 — 카탈로그 equipmentOptions/mountOptions의 키와 같은 순서(1옵, 2옵). */
export const GEAR_OPTION_KEYS = ["opt1", "opt2"];
/** 속성치 셀렉트의 "텍스트박스" 선택지 값 — 고르면 statText 입력칸이 열린다. */
export const STAT_TEXT = "text";

const emptyGearOptions = () => GEAR_OPTION_KEYS.map(() => []);

/** 빈 장수 하나(덱 양식의 장수 칸). */
export function emptyGeneral() {
  return {
    name: "",
    portraitId: null, // DeckStore images 스토어의 Blob 키
    needsTally: false, // 병부 필요 여부(초상화 오른쪽 위 마크)
    troopType: null,
    troopTradition: null,
    tactics: Array.from({ length: TACTIC_COUNT }, () => ({ text: "", alternatives: [], required: false })), // required = 필수 전법(★)
    arts: Array.from({ length: ART_COUNT }, () => null),
    equipmentOptions: emptyGearOptions(), // [옵] = 그 옵 후보 중 추천 id들(개수 제한 없음, 앞부터 추천 순서)
    mountOptions: emptyGearOptions(), // 장비와 같은 형식
    statChoice: null, // statOptions id 또는 STAT_TEXT
    statText: "", // statChoice === STAT_TEXT일 때 직접 입력한 내용
  };
}

/** 보드 위 필드 종류 — "deck" = 덱 양식(장수 3명), "list" = 리스트 템플릿(시즌 제목 + 장수 목록 +
 * 전법 목록, 개수 제한 없음). 둘 다 model.decks에 같이 들어 있어서 드래그·스냅·관계선·⋯ 메뉴·
 * 실행취소·저장을 그대로 같이 쓴다. kind가 없는 예전 데이터는 덱. */
export const DECK_KINDS = ["deck", "list"];

/** 리스트의 장수 한 칸 — 이름이 같으면 덱·다른 리스트의 장수와 같은 장수로 본다(하이라이트). */
export const emptyListGeneral = () => ({ name: "", portraitId: null });

/** 덱(또는 리스트)이 쓰는 초상화 id들 — 이미지 모으기·다시 그리기에 쓴다. */
export function deckPortraitIds(deck) {
  const gens = deck.kind === "list" ? deck.listGenerals : deck.generals;
  return (gens || []).map((g) => g.portraitId).filter(Boolean);
}

/** 장수 이름 비교용 — 앞뒤 공백·대소문자 차이는 같은 이름으로 본다. 빈 이름은 ""(아무것과도 안 맞음). */
export function generalKey(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeList(deck) {
  return {
    id: deck.id || uuid(),
    kind: "list",
    x: deck.x ?? 0,
    y: deck.y ?? 0,
    locked: !!deck.locked,
    season: deck.season || "",
    listGenerals: (Array.isArray(deck.listGenerals) ? deck.listGenerals : []).map((g) => ({
      name: g?.name || "",
      portraitId: g?.portraitId ?? null,
    })),
    listTactics: (Array.isArray(deck.listTactics) ? deck.listTactics : []).map((t) => (typeof t === "string" ? t : "")),
    createdAt: deck.createdAt || Date.now(),
    updatedAt: deck.updatedAt || Date.now(),
  };
}

/** 저장된(또는 가져온) 덱을 지금 양식에 맞춘다 — 빠진 칸은 채우고, 개수는 양식대로 맞춘다.
 * 나중에 양식이 바뀌어도(항목 추가 등) 예전 덱을 그대로 불러올 수 있게 하는 안전장치. */
export function normalizeDeck(deck) {
  if (deck.kind === "list") return normalizeList(deck);
  // 아는 항목만 골라 담는다 — 예전 양식에만 있던 값(장비/탈것 단일 선택, 속성치 숫자 등)은 버린다.
  const generals = Array.from({ length: GENERAL_COUNT }, (_, i) => {
    const src = deck.generals?.[i] || {};
    const g = emptyGeneral();
    g.name = src.name || "";
    g.portraitId = src.portraitId ?? null;
    g.needsTally = !!src.needsTally;
    g.troopType = src.troopType ?? null;
    g.troopTradition = src.troopTradition ?? null;
    g.tactics = g.tactics.map((_, t) => ({
      text: src.tactics?.[t]?.text || "",
      alternatives: [...(src.tactics?.[t]?.alternatives || [])],
      required: !!src.tactics?.[t]?.required,
    }));
    g.arts = g.arts.map((_, a) => src.arts?.[a] ?? null);
    const gearRows = (rows) => GEAR_OPTION_KEYS.map((_, o) => (Array.isArray(rows?.[o]) ? rows[o].filter(Boolean) : []));
    g.equipmentOptions = gearRows(src.equipmentOptions);
    g.mountOptions = gearRows(src.mountOptions);
    g.statChoice = src.statChoice ?? null;
    g.statText = src.statText || "";
    return g;
  });
  return {
    id: deck.id || uuid(),
    kind: "deck",
    x: deck.x ?? 0,
    y: deck.y ?? 0,
    locked: !!deck.locked,
    name: deck.name || "",
    formation: deck.formation ?? null,
    notes: deck.notes || "",
    generals,
    createdAt: deck.createdAt || Date.now(),
    updatedAt: deck.updatedAt || Date.now(),
  };
}

/** 덱끼리 잇는 관계선 하나. type은 가계도 RelationshipLine.js가 아는 값("arrow" = 화살촉 있음,
 * "custom" = 그냥 선)이라 그 그리기 코드를 그대로 쓴다. template은 만들 때 고른 관계 템플릿 id. */
export function normalizeRelation(rel) {
  return {
    id: rel.id || uuid(),
    fromId: rel.fromId,
    toId: rel.toId,
    type: rel.type === "arrow" ? "arrow" : "custom",
    template: rel.template ?? null,
    label: rel.label || "",
    color: rel.color ?? null,
    lineStyle: rel.lineStyle ?? null,
    bidirectional: !!rel.bidirectional,
  };
}

/** 덱 내용만(위치/id/시각 없이) 깊은 복사 — 복제·템플릿 저장·내보내기에 쓴다. */
export function cloneDeckContent(deck) {
  const { id, x, y, locked, createdAt, updatedAt, ...content } = JSON.parse(JSON.stringify(deck));
  return content;
}

/**
 * 덱 보드 데이터 모델. TreeModel(가계도)과 같은 onChange / toJSON / loadJSON 인터페이스라서
 * UndoManager를 그대로 붙여 쓸 수 있다.
 */
export class DeckModel {
  constructor() {
    this.decks = new Map(); // id -> Deck
    this.relations = new Map(); // id -> Relation(덱끼리 잇는 관계선)
    this.view = { panX: 0, panY: 0, scale: 1 };
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this._listeners) fn(type, payload);
  }

  /** content: cloneDeckContent()의 결과 등 일부만 채운 객체도 된다(빈 칸은 양식 기본값). */
  addDeck(content = {}, { x = 0, y = 0 } = {}) {
    const deck = normalizeDeck({ ...content, id: uuid(), x, y, locked: false, createdAt: Date.now(), updatedAt: Date.now() });
    this.decks.set(deck.id, deck);
    this._emit("deck:add", deck);
    return deck;
  }

  /** 위치/잠금처럼 덱 최상위 값을 바꾼다. */
  updateDeck(id, patch) {
    const deck = this.decks.get(id);
    if (!deck) return;
    Object.assign(deck, patch);
    this._emit("deck:update", deck);
  }

  /** "generals.0.tactics.1.text"처럼 점으로 이은 경로의 값 하나를 바꾼다 — 덱 양식의 모든
   * 입력칸이 data-path로 자기 경로를 들고 있어서, 입력 이벤트 하나로 다 처리된다. */
  setPath(id, path, value) {
    const deck = this.decks.get(id);
    if (!deck) return;
    const keys = path.split(".");
    let target = deck;
    for (const key of keys.slice(0, -1)) {
      if (target[key] == null) return;
      target = target[key];
    }
    target[keys[keys.length - 1]] = value;
    deck.updatedAt = Date.now();
    this._emit("deck:update", deck);
  }

  getPath(id, path) {
    let target = this.decks.get(id);
    for (const key of path.split(".")) {
      if (target == null) return undefined;
      target = target[key];
    }
    return target;
  }

  /** 덱을 지우면 그 덱에 이어진 관계선도 같이 지운다(실행취소하면 둘 다 돌아온다). */
  removeDeck(id) {
    if (!this.decks.has(id)) return;
    for (const rel of [...this.relations.values()]) {
      if (rel.fromId === id || rel.toId === id) this.removeRelation(rel.id);
    }
    this.decks.delete(id);
    this._emit("deck:remove", id);
  }

  addRelation(fields) {
    if (!fields.fromId || !fields.toId || fields.fromId === fields.toId) return null;
    if (!this.decks.has(fields.fromId) || !this.decks.has(fields.toId)) return null;
    const rel = normalizeRelation({ ...fields, id: null });
    this.relations.set(rel.id, rel);
    this._emit("relation:add", rel);
    return rel;
  }

  updateRelation(id, patch) {
    const rel = this.relations.get(id);
    if (!rel) return;
    Object.assign(rel, patch);
    this._emit("relation:update", rel);
  }

  removeRelation(id) {
    if (!this.relations.delete(id)) return;
    this._emit("relation:remove", id);
  }

  toJSON() {
    return { decks: [...this.decks.values()], relations: [...this.relations.values()], view: this.view };
  }

  loadJSON(data) {
    this.decks = new Map((data.decks || []).map((d) => {
      const deck = normalizeDeck(d);
      return [deck.id, deck];
    }));
    // 양 끝 덱이 다 있는 관계선만 살린다(가져온 파일이 깨져 있어도 엉뚱한 선이 안 남게).
    this.relations = new Map((data.relations || [])
      .filter((r) => this.decks.has(r.fromId) && this.decks.has(r.toId) && r.fromId !== r.toId)
      .map((r) => {
        const rel = normalizeRelation(r);
        return [rel.id, rel];
      }));
    this.view = data.view || { panX: 0, panY: 0, scale: 1 };
    this._emit("reset", null);
  }
}
