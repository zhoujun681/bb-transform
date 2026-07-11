// storage.js — client-side saved-message history (IndexedDB)
//
// Persists user-saved conversation snapshots so they can be reviewed later.
// Blobs (transferred files) are stored directly in IndexedDB (structured clone
// handles Blob), so "include files" records carry the real bytes — no base64.
//
// Storage:
//   - IndexedDB: DB "bbt", object store "conversations" keyPath "id".
//     Records: { id, savedAt, title, messages: [ ...normalized entries ] }
//   - localStorage "bbt.history.maxKeep": how many records to retain (default 10).
//     On every save, the oldest records beyond maxKeep are deleted automatically.
//
// This module mirrors the identity.js idiom: a singleton IIFE assigned to a const.

const Storage = (() => {
  const DB_NAME = 'bbt';
  const STORE = 'conversations';
  const MAX_KEEP_KEY = 'bbt.history.maxKeep';
  const DEFAULT_MAX_KEEP = 10;

  let _db = null;

  // Open (and upgrade-create) the DB. Cached after first open.
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        _db = req.result;
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function genId() {
    const b = crypto.getRandomValues(new Uint8Array(12));
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function getMaxKeep() {
    const n = parseInt(localStorage.getItem(MAX_KEEP_KEY) || '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_KEEP;
  }

  function setMaxKeep(n) {
    n = Math.max(1, parseInt(n, 10) || DEFAULT_MAX_KEEP);
    localStorage.setItem(MAX_KEEP_KEY, String(n));
    return n;
  }

  // Insert a record, then trim to maxKeep (delete the oldest by savedAt).
  async function saveConversation(record) {
    record.id = record.id || genId();
    record.savedAt = record.savedAt || Date.now();
    const store = await tx('readwrite');
    await reqToPromise(store.put(record));
    // trim oldest beyond maxKeep
    const all = await reqToPromise(store.getAll());
    const max = getMaxKeep();
    if (all.length > max) {
      all.sort((a, b) => a.savedAt - b.savedAt);
      const toDelete = all.slice(0, all.length - max);
      for (const r of toDelete) {
        store.delete(r.id);
      }
    }
    return record;
  }

  async function listConversations() {
    const store = await tx('readonly');
    const all = await reqToPromise(store.getAll());
    // newest first
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  async function getConversation(id) {
    const store = await tx('readonly');
    return reqToPromise(store.get(id));
  }

  async function deleteConversation(id) {
    const store = await tx('readwrite');
    return reqToPromise(store.delete(id));
  }

  async function clearAll() {
    const store = await tx('readwrite');
    return reqToPromise(store.clear());
  }

  return {
    saveConversation,
    listConversations,
    getConversation,
    deleteConversation,
    clearAll,
    getMaxKeep,
    setMaxKeep,
  };
})();
