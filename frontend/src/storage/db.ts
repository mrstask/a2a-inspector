export const DB_NAME = 'a2a-inspector';
export const DB_VERSION = 1;

export const STORE_PROFILES = 'profiles';
export const STORE_DIALOGS = 'dialogs';
export const STORE_META = 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;
let memoryFallback = false;

export function isAvailable(): boolean {
  if (memoryFallback) return false;
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export async function resetForTests(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbPromise = null;
  memoryFallback = false;
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (!isAvailable()) {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        const profiles = db.createObjectStore(STORE_PROFILES, {keyPath: 'id'});
        profiles.createIndex('byUpdatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE_DIALOGS)) {
        const dialogs = db.createObjectStore(STORE_DIALOGS, {keyPath: 'id'});
        dialogs.createIndex('byProfileId', 'profileId');
        dialogs.createIndex('byUpdatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, {keyPath: 'key'});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  return dbPromise;
}

export type TxMode = 'readonly' | 'readwrite';

export async function runTx<T>(
  storeNames: string | string[],
  mode: TxMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const result = fn(tx);
  return new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => {
      Promise.resolve(result).then(resolve, reject);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function nowIso(): string {
  return new Date().toISOString();
}
