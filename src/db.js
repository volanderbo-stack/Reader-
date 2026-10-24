// Локальна бібліотека в IndexedDB: документи, фото (оригінали, кадри, вирізані зображення) і відео.
//
// Документ:
// { id, title, folder, tags[], engine, createdAt, updatedAt,
//   blocks: [
//     { id, type: 'text',   markdown },
//     { id, type: 'figure', imageId, description },
//     { id, type: 'qr',     value, format },
//     { id, type: 'video',  caption, videoId|null, posterId|null, transcript },
//   ],
//   sources: [{ imageId, kind: 'photo'|'frame', label }] }

const DB_NAME = 'zchytuvach';
const DB_VERSION = 2;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          const docs = db.createObjectStore('documents', { keyPath: 'id' });
          docs.createIndex('createdAt', 'createdAt');
          db.createObjectStore('images', { keyPath: 'id' });
        }
        if (e.oldVersion < 2) {
          db.createObjectStore('videos', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function newId() {
  return crypto.randomUUID();
}

// Документи першої версії мали одне поле text — перетворюємо на блоки.
function normalize(doc) {
  if (!doc) return doc;
  const blocks = doc.blocks ?? (doc.text ? [{ id: newId(), type: 'text', markdown: doc.text }] : []);
  const sources = doc.sources ?? (doc.imageId ? [{ imageId: doc.imageId, kind: 'photo', label: 'Фото 1' }] : []);
  const { text, imageId, ...rest } = doc;
  return { folder: '', tags: [], ...rest, blocks, sources };
}

export async function saveDocument(doc, { images = [], videos = [] } = {}) {
  return run(['documents', 'images', 'videos'], 'readwrite', (tx) => {
    images.forEach(({ id, blob }) => tx.objectStore('images').put({ id, blob }));
    videos.forEach(({ id, blob }) => tx.objectStore('videos').put({ id, blob }));
    tx.objectStore('documents').put({ ...doc, updatedAt: Date.now() });
  });
}

export async function getDocument(id) {
  return normalize(await run(['documents'], 'readonly', (tx) => tx.objectStore('documents').get(id)));
}

export async function listDocuments() {
  const docs = await run(['documents'], 'readonly', (tx) => tx.objectStore('documents').getAll());
  return docs.map(normalize).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getImage(id) {
  const rec = await run(['images'], 'readonly', (tx) => tx.objectStore('images').get(id));
  return rec?.blob;
}

export async function getVideo(id) {
  const rec = await run(['videos'], 'readonly', (tx) => tx.objectStore('videos').get(id));
  return rec?.blob;
}

export async function deleteMedia({ imageIds = [], videoIds = [] }) {
  return run(['images', 'videos'], 'readwrite', (tx) => {
    imageIds.filter(Boolean).forEach((id) => tx.objectStore('images').delete(id));
    videoIds.filter(Boolean).forEach((id) => tx.objectStore('videos').delete(id));
  });
}

export function mediaOf(doc) {
  const imageIds = [
    ...doc.sources.map((s) => s.imageId),
    ...doc.blocks.flatMap((b) => [b.imageId, b.posterId]),
  ].filter(Boolean);
  const videoIds = doc.blocks.map((b) => b.videoId).filter(Boolean);
  return { imageIds, videoIds };
}

export async function deleteDocument(doc) {
  const { imageIds, videoIds } = mediaOf(doc);
  return run(['documents', 'images', 'videos'], 'readwrite', (tx) => {
    tx.objectStore('documents').delete(doc.id);
    imageIds.forEach((id) => tx.objectStore('images').delete(id));
    videoIds.forEach((id) => tx.objectStore('videos').delete(id));
  });
}
