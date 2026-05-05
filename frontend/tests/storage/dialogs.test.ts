import {beforeEach, describe, expect, it} from 'vitest';
import {DB_NAME, resetForTests} from '../../src/storage/db';
import {
  appendDebugEvent,
  appendMessage,
  createDialog,
  deleteDialog,
  deleteDialogsByProfile,
  getDialog,
  listDialogsByProfile,
  patchDialog,
  updateDialog,
} from '../../src/storage/dialogs';
import {upsertProfile} from '../../src/storage/profiles';
import type {AgentProfile} from '../../src/state/types';

async function wipe(): Promise<void> {
  await resetForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function makeProfile(name = 'P'): Promise<AgentProfile> {
  return upsertProfile({
    name,
    agentCardUrl: 'http://x/' + name,
    authType: 'none',
    authConfig: {},
    customHeaders: [],
    defaultMetadata: [],
  });
}

describe('storage/dialogs', () => {
  beforeEach(async () => {
    await wipe();
  });

  it('creates a dialog with defaults', async () => {
    const p = await makeProfile();
    const d = await createDialog({profileId: p.id, title: 'Hi'});
    expect(d.id).toBeTruthy();
    expect(d.messages).toEqual([]);
    expect(d.debugEvents).toEqual([]);
    expect(d.contextId).toBeNull();
  });

  it('lists dialogs by profile', async () => {
    const p1 = await makeProfile('one');
    const p2 = await makeProfile('two');
    await createDialog({profileId: p1.id, title: 'a'});
    await createDialog({profileId: p1.id, title: 'b'});
    await createDialog({profileId: p2.id, title: 'c'});

    const forP1 = await listDialogsByProfile(p1.id);
    const forP2 = await listDialogsByProfile(p2.id);
    expect(forP1).toHaveLength(2);
    expect(forP2).toHaveLength(1);
  });

  it('appends messages and debug events atomically', async () => {
    const p = await makeProfile();
    const d = await createDialog({profileId: p.id, title: 't'});
    await appendMessage(d.id, {
      id: 'm1',
      role: 'user',
      text: 'hello',
      createdAt: new Date().toISOString(),
    });
    await appendDebugEvent(d.id, {
      id: 'e1',
      direction: 'request',
      payload: {x: 1},
      createdAt: new Date().toISOString(),
    });
    const fresh = await getDialog(d.id);
    expect(fresh?.messages).toHaveLength(1);
    expect(fresh?.debugEvents).toHaveLength(1);
  });

  it('promotes default dialog titles from the first user message', async () => {
    const p = await makeProfile();
    const d = await createDialog({profileId: p.id, title: 'Dialog @ 11:36'});
    await appendMessage(d.id, {
      id: 'agent-1',
      role: 'agent',
      text: 'Hello. How can I help?',
      createdAt: new Date().toISOString(),
    });
    await appendMessage(d.id, {
      id: 'user-1',
      role: 'user',
      text: 'how long is this file',
      createdAt: new Date().toISOString(),
    });

    const fresh = await getDialog(d.id);
    expect(fresh?.title).toBe('how long is this file');
  });

  it('keeps custom dialog titles when messages are appended', async () => {
    const p = await makeProfile();
    const d = await createDialog({profileId: p.id, title: 'Pinned title'});
    await appendMessage(d.id, {
      id: 'user-1',
      role: 'user',
      text: 'replace me?',
      createdAt: new Date().toISOString(),
    });

    const fresh = await getDialog(d.id);
    expect(fresh?.title).toBe('Pinned title');
  });

  it('preserves messages when appends and dialog patches overlap', async () => {
    const p = await makeProfile();
    const d = await createDialog({profileId: p.id, title: 't'});

    await Promise.all([
      appendMessage(d.id, {
        id: 'user-1',
        role: 'user',
        text: 'hi',
        createdAt: new Date().toISOString(),
      }),
      appendMessage(d.id, {
        id: 'agent-1',
        role: 'agent',
        html: '<p>hello back</p>',
        createdAt: new Date().toISOString(),
      }),
      patchDialog(d.id, {contextId: 'ctx-1'}),
    ]);

    const fresh = await getDialog(d.id);
    expect(fresh?.contextId).toBe('ctx-1');
    expect(fresh?.messages.map(m => m.id).sort()).toEqual([
      'agent-1',
      'user-1',
    ]);
  });

  it('updateDialog bumps updatedAt', async () => {
    const p = await makeProfile();
    const d = await createDialog({profileId: p.id, title: 't'});
    const original = d.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const after = await updateDialog({...d, title: 't2'});
    expect(after.title).toBe('t2');
    expect(after.updatedAt).not.toBe(original);
  });

  it('deletes a dialog', async () => {
    const p = await makeProfile();
    const d = await createDialog({profileId: p.id, title: 't'});
    await deleteDialog(d.id);
    expect(await getDialog(d.id)).toBeUndefined();
  });

  it('deletes all dialogs for a profile', async () => {
    const p1 = await makeProfile('one');
    const p2 = await makeProfile('two');
    await createDialog({profileId: p1.id, title: 'a'});
    await createDialog({profileId: p1.id, title: 'b'});
    await createDialog({profileId: p2.id, title: 'c'});
    await deleteDialogsByProfile(p1.id);
    expect(await listDialogsByProfile(p1.id)).toHaveLength(0);
    expect(await listDialogsByProfile(p2.id)).toHaveLength(1);
  });
});
