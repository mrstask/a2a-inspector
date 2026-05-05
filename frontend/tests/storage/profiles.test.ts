import {beforeEach, describe, expect, it} from 'vitest';
import {DB_NAME, resetForTests} from '../../src/storage/db';
import {
  deleteProfile,
  findByUrl,
  getProfile,
  listProfiles,
  upsertImplicit,
  upsertProfile,
} from '../../src/storage/profiles';

async function wipe(): Promise<void> {
  await resetForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('storage/profiles', () => {
  beforeEach(async () => {
    await wipe();
  });

  it('upserts and lists profiles', async () => {
    const created = await upsertProfile({
      name: 'Test Agent',
      agentCardUrl: 'http://localhost:5555',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const all = await listProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Test Agent');
  });

  it('updates an existing profile by id', async () => {
    const a = await upsertProfile({
      name: 'A',
      agentCardUrl: 'http://x',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    const updated = await upsertProfile({...a, name: 'A2'});
    expect(updated.id).toBe(a.id);
    expect(updated.name).toBe('A2');
    const all = await listProfiles();
    expect(all).toHaveLength(1);
  });

  it('deletes a profile', async () => {
    const a = await upsertProfile({
      name: 'A',
      agentCardUrl: 'http://x',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    await deleteProfile(a.id);
    expect(await getProfile(a.id)).toBeUndefined();
  });

  it('upsertImplicit creates a profile if URL not seen', async () => {
    const p = await upsertImplicit('http://newhost:5555', {Foo: 'bar'});
    expect(p.isImplicit).toBe(true);
    expect(p.customHeaders).toEqual([{name: 'Foo', value: 'bar'}]);
    expect(p.lastConnectedAt).toBeTruthy();
  });

  it('upsertImplicit reuses an existing profile by URL', async () => {
    const first = await upsertImplicit('http://same:5555');
    const second = await upsertImplicit('http://same:5555');
    expect(second.id).toBe(first.id);
    const all = await listProfiles();
    expect(all).toHaveLength(1);
  });

  it('findByUrl returns the matching profile', async () => {
    await upsertImplicit('http://a');
    await upsertImplicit('http://b');
    const match = await findByUrl('http://b');
    expect(match?.agentCardUrl).toBe('http://b');
  });
});
