import {beforeEach, describe, expect, it} from 'vitest';
import {
  DB_NAME,
  DB_VERSION,
  STORE_DIALOGS,
  STORE_META,
  STORE_PROFILES,
  isAvailable,
  openDb,
  resetForTests,
  uuid,
} from '../../src/storage/db';

async function wipe(): Promise<void> {
  await resetForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('storage/db', () => {
  beforeEach(async () => {
    await wipe();
  });

  it('reports IndexedDB available in test env', () => {
    expect(isAvailable()).toBe(true);
  });

  it('opens the database with expected schema', async () => {
    const db = await openDb();
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames.contains(STORE_PROFILES)).toBe(true);
    expect(db.objectStoreNames.contains(STORE_DIALOGS)).toBe(true);
    expect(db.objectStoreNames.contains(STORE_META)).toBe(true);
  });

  it('creates expected indexes on dialogs', async () => {
    const db = await openDb();
    const tx = db.transaction(STORE_DIALOGS, 'readonly');
    const store = tx.objectStore(STORE_DIALOGS);
    expect(Array.from(store.indexNames)).toEqual(
      expect.arrayContaining(['byProfileId', 'byUpdatedAt']),
    );
  });

  it('uuid produces unique strings', () => {
    const a = uuid();
    const b = uuid();
    expect(a).not.toBe(b);
    expect(typeof a).toBe('string');
  });
});
