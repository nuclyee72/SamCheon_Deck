/**
 * 덱 보드 IndexedDB 래퍼. 가계도(familyTreeDB)와는 DB 자체가 달라서 서로 영향이 없다.
 * - decks         : 보드 위 덱들
 * - images        : 초상화 Blob(덱에는 portraitId만 저장)
 * - deckTemplates : "템플릿으로 저장"한 덱 — 보드 데이터와 별개라 내보내기·실행취소에 안 섞인다
 * - meta          : 뷰 상태(pan/zoom), 덱끼리의 관계선 목록("relations")
 */
import { deckPortraitIds } from "./DeckModel.js";

const DB_NAME = "samgukDeckDB";
const DB_VERSION = 1;
export const EXPORT_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("decks")) db.createObjectStore("decks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
      if (!db.objectStoreNames.contains("deckTemplates")) db.createObjectStore("deckTemplates", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)]));
    let result;
    Promise.resolve(fn(stores))
      .then((r) => (result = r))
      .catch((err) => {
        try { t.abort(); } catch { /* ignore */ }
        reject(err);
      });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
  });
}

export class DeckStore {
  constructor() {
    this._dbPromise = openDB();
  }

  async saveAll(model) {
    const db = await this._dbPromise;
    return runTx(db, ["decks", "meta"], "readwrite", (s) => {
      s.decks.clear();
      for (const d of model.decks.values()) s.decks.put(d);
      s.meta.put(model.view, "view");
      s.meta.put([...model.relations.values()], "relations");
      s.meta.put(model.updatedAt ?? null, "updatedAt");
    });
  }

  async loadAll() {
    const db = await this._dbPromise;
    return runTx(db, ["decks", "meta"], "readonly", async (s) => {
      const decks = await reqToPromise(s.decks.getAll());
      const view = await reqToPromise(s.meta.get("view"));
      const relations = await reqToPromise(s.meta.get("relations"));
      const updatedAt = await reqToPromise(s.meta.get("updatedAt"));
      return { decks, relations: relations || [], view: view || { panX: 0, panY: 0, scale: 1 }, updatedAt: updatedAt ?? null };
    });
  }

  async putImage(id, blob) {
    const db = await this._dbPromise;
    return runTx(db, ["images"], "readwrite", (s) => s.images.put(blob, id));
  }

  async getImage(id) {
    const db = await this._dbPromise;
    return runTx(db, ["images"], "readonly", (s) => reqToPromise(s.images.get(id)));
  }

  /** keepIds(Set)에 없는 초상화 Blob을 지운다. 지운 개수를 돌려준다. */
  async pruneImages(keepIds) {
    const db = await this._dbPromise;
    return runTx(db, ["images"], "readwrite", async (s) => {
      const keys = await reqToPromise(s.images.getAllKeys());
      const stale = keys.filter((k) => !keepIds.has(k));
      for (const k of stale) s.images.delete(k);
      return stale.length;
    });
  }

  /** 덱들이 쓰는 초상화 Blob을 { portraitId: Blob }으로 모은다(템플릿 저장·내보내기용 사본). */
  async collectImages(decks) {
    const images = {};
    for (const deck of decks) {
      for (const pid of deckPortraitIds(deck)) {
        if (images[pid]) continue;
        const blob = await this.getImage(pid);
        if (blob) images[pid] = blob;
      }
    }
    return images;
  }

  /** { portraitId: Blob } 중 아직 없는 것만 써넣는다 — 덱을 만들기 "전에" 불러야 카드가 그려지는
   * 순간 사진을 바로 읽을 수 있다(가계도 importJSON과 같은 이유). */
  async restoreImages(images) {
    for (const [id, blob] of Object.entries(images || {})) {
      if (!(await this.getImage(id))) await this.putImage(id, blob);
    }
  }

  async listTemplates() {
    const db = await this._dbPromise;
    const list = await runTx(db, ["deckTemplates"], "readonly", (s) => reqToPromise(s.deckTemplates.getAll()));
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  async putTemplate(template) {
    const db = await this._dbPromise;
    return runTx(db, ["deckTemplates"], "readwrite", (s) => s.deckTemplates.put(template));
  }

  async deleteTemplate(id) {
    const db = await this._dbPromise;
    return runTx(db, ["deckTemplates"], "readwrite", (s) => s.deckTemplates.delete(id));
  }
}

/**
 * 공개 보기(방문자)용 저장소 — DeckStore와 같은 모양이지만 아무것도 브라우저에 남기지 않는다.
 * 게시된 data/board.json을 메모리에만 올려서 보여주고, 방문자가 무엇을 해도 저장되지 않는다.
 */
export class MemoryDeckStore {
  constructor() {
    this.images = new Map();
  }
  async saveAll() {}
  async loadAll() { return { decks: [], relations: [], view: { panX: 0, panY: 0, scale: 1 } }; }
  async putImage(id, blob) { this.images.set(id, blob); }
  async getImage(id) { return this.images.get(id); }
  async collectImages(decks) {
    const images = {};
    for (const deck of decks) {
      for (const pid of deckPortraitIds(deck)) if (this.images.has(pid)) images[pid] = this.images.get(pid);
    }
    return images;
  }
  async restoreImages(images) {
    for (const [id, blob] of Object.entries(images || {})) if (!this.images.has(id)) this.images.set(id, blob);
  }
  async pruneImages() { return 0; }
  async listTemplates() { return []; }
  async putTemplate() {}
  async deleteTemplate() {}
}

export async function imagesToDataURLs(images) {
  const out = {};
  for (const [id, blob] of Object.entries(images)) out[id] = await blobToDataURL(blob);
  return out;
}

export async function dataURLsToImages(dataUrls) {
  const out = {};
  for (const [id, url] of Object.entries(dataUrls || {})) out[id] = await (await fetch(url)).blob();
  return out;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
