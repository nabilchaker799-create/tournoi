// Brouillon de création de tournoi, stocké dans le navigateur (IndexedDB).
// IndexedDB garde aussi les images (fichiers), contrairement à localStorage.

const DB_NAME = 'k40-power';
const STORE = 'drafts';

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB indisponible')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const key = uid => `create:${uid}`;

export async function loadDraft(uid) {
  try { return (await run('readonly', s => s.get(key(uid)))) || null; }
  catch (e) { console.warn('Brouillon illisible', e); return null; }
}

export async function saveDraft(uid, data) {
  await run('readwrite', s => s.put({ ...data, savedAt: Date.now() }, key(uid)));
  // Demande au navigateur de ne pas effacer ces données s'il manque de place
  try { await navigator.storage?.persist?.(); } catch { /* rien */ }
}

export async function clearDraft(uid) {
  try { await run('readwrite', s => s.delete(key(uid))); }
  catch (e) { console.warn('Suppression du brouillon impossible', e); }
}