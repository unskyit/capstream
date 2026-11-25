/**
 * CapStream — Reactive State Store, Undo/Redo & Native IndexedDB Persistence
 * Powered by Unskyit (Zero external dependencies)
 */
import { DEFAULT_FRAME, DEFAULT_FX } from "./renderer.js";
import { DEFAULT_TEMPLATE_ID, getTemplate } from "./templates.js";

/* ------------------------------------------------------------------ IndexedDB Helper */
const DB_NAME = "capstream-unskyit-db";
const STORE_NAME = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function idbSet(key, value) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage quota errors gracefully
  }
}

export async function idbDel(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

/* ------------------------------------------------------------------ Document Factory */
export function createEmptyDoc(isAudioOnly = false) {
  const tpl = getTemplate(DEFAULT_TEMPLATE_ID);
  return {
    pages: [],
    style: structuredClone(tpl.style),
    templateId: tpl.id,
    fx: structuredClone(DEFAULT_FX),
    frame: {
      ...structuredClone(DEFAULT_FRAME),
      aspect: isAudioOnly ? "9:16" : "source",
      bgMode: isAudioOnly ? "waveform" : "video",
    },
    offset: 0,
  };
}

/* ------------------------------------------------------------------ Store */
const MAX_HISTORY = 60;

class Store {
  constructor() {
    this.state = {
      screen: "upload", // upload | processing | studio | batch
      file: null,
      mediaUrl: null,
      meta: null,
      peaks: null,
      doc: createEmptyDoc(false),
      past: [],
      future: [],
      activeTab: "styles", // styles | customize | transcript | effects | frame
      styleFilter: "all", // all | viral | classic
      showLiveTelemetry: true,
      progress: {
        step: "read",
        ratio: 0,
        percent: 0,
        detail: "",
        startedAt: 0,
      },
      error: null,
      currentTime: 0,
      playing: false,
      detectedLanguage: null,
    };
    this.listeners = new Set();
    this._saveTimer = null;
  }

  get() {
    return this.state;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.listeners.forEach((fn) => fn(this.state));
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit();
  }

  updateDoc(updater, recordHistory = true) {
    const prev = this.state.doc;
    const next = structuredClone(prev);
    updater(next);
    if (recordHistory) {
      this.state.past = [...this.state.past.slice(-(MAX_HISTORY - 1)), prev];
      this.state.future = [];
    }
    this.state.doc = next;
    this.emit();
    this.scheduleDraftSave();
  }

  undo() {
    if (!this.state.past.length) return;
    const prev = this.state.past[this.state.past.length - 1];
    this.state.past = this.state.past.slice(0, -1);
    this.state.future = [this.state.doc, ...this.state.future.slice(0, MAX_HISTORY - 1)];
    this.state.doc = prev;
    this.emit();
    this.scheduleDraftSave();
  }

  redo() {
    if (!this.state.future.length) return;
    const next = this.state.future[0];
    this.state.future = this.state.future.slice(1);
    this.state.past = [...this.state.past.slice(-(MAX_HISTORY - 1)), this.state.doc];
    this.state.doc = next;
    this.emit();
    this.scheduleDraftSave();
  }

  scheduleDraftSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      if (this.state.file && this.state.meta && this.state.doc) {
        idbSet("draft-v1", {
          file: this.state.file,
          meta: this.state.meta,
          peaks: this.state.peaks,
          doc: this.state.doc,
          savedAt: Date.now(),
        });
      }
    }, 800);
  }

  async clearDraft() {
    clearTimeout(this._saveTimer);
    await idbDel("draft-v1");
  }

  async loadDraft() {
    return idbGet("draft-v1");
  }
}

export const store = new Store();
