import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DB_NAME, resetForTests} from '../../src/storage/db';
import {mountSidebar} from '../../src/ui/sidebar';
import {createDialog, listDialogsByProfile} from '../../src/storage/dialogs';
import {upsertProfile} from '../../src/storage/profiles';

async function wipe(): Promise<void> {
  await resetForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  localStorage.clear?.();
}

function root(): HTMLElement {
  document.body.innerHTML = '<aside id="sb"></aside>';
  return document.getElementById('sb')!;
}

const noopHooks = {
  loadDialog: vi.fn(),
  resetChat: vi.fn(),
};

describe('ui/sidebar', () => {
  beforeEach(async () => {
    await wipe();
    noopHooks.loadDialog.mockClear();
    noopHooks.resetChat.mockClear();
  });

  it('shows empty state when no profile is active', async () => {
    const r = root();
    await mountSidebar(r, {
      getActiveProfileId: () => null,
      ...noopHooks,
    });
    const empty = r.querySelector<HTMLDivElement>('#sidebar-empty')!;
    expect(empty.style.display).not.toBe('none');
    expect(empty.textContent).toMatch(/No profile/);
  });

  it('lists dialogs for the active profile', async () => {
    const p = await upsertProfile({
      name: 'P',
      agentCardUrl: 'http://x',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    await createDialog({profileId: p.id, title: 'one'});
    await createDialog({profileId: p.id, title: 'two'});

    const r = root();
    await mountSidebar(r, {
      getActiveProfileId: () => p.id,
      ...noopHooks,
    });
    const items = r.querySelectorAll('.sidebar-item');
    expect(items).toHaveLength(2);
  });

  it('shows first user message instead of the default timestamp title', async () => {
    const p = await upsertProfile({
      name: 'P',
      agentCardUrl: 'http://x',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    await createDialog({
      profileId: p.id,
      title: 'Dialog @ 11:36',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'how long is this file',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const r = root();
    await mountSidebar(r, {
      getActiveProfileId: () => p.id,
      ...noopHooks,
    });

    const btn = r.querySelector<HTMLButtonElement>('.sidebar-item-label')!;
    expect(btn.textContent).toBe('how long is this file (1)');
  });

  it('creates a new dialog and triggers resetChat', async () => {
    const p = await upsertProfile({
      name: 'P',
      agentCardUrl: 'http://x',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    const r = root();
    const sb = await mountSidebar(r, {
      getActiveProfileId: () => p.id,
      ...noopHooks,
    });
    const created = await sb.createDialogForActiveProfile('My title');
    expect(created?.title).toBe('My title');
    expect(noopHooks.resetChat).toHaveBeenCalled();
    const all = await listDialogsByProfile(p.id);
    expect(all).toHaveLength(1);
    expect(sb.getActiveDialogId()).toBe(created!.id);
  });

  it('clicking a dialog calls loadDialog with the saved record', async () => {
    const p = await upsertProfile({
      name: 'P',
      agentCardUrl: 'http://x',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    const d = await createDialog({profileId: p.id, title: 'click me'});
    const r = root();
    await mountSidebar(r, {
      getActiveProfileId: () => p.id,
      ...noopHooks,
    });
    const btn = r.querySelector<HTMLButtonElement>('.sidebar-item-label')!;
    btn.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(noopHooks.loadDialog).toHaveBeenCalled();
    const arg = noopHooks.loadDialog.mock.calls[0][0];
    expect(arg.id).toBe(d.id);
    expect(arg.title).toBe('click me');
  });

  it('updateActiveDialog patches the active record', async () => {
    const p = await upsertProfile({
      name: 'P',
      agentCardUrl: 'http://x',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    const r = root();
    const sb = await mountSidebar(r, {
      getActiveProfileId: () => p.id,
      ...noopHooks,
    });
    const created = await sb.createDialogForActiveProfile('orig');
    await sb.updateActiveDialog({contextId: 'ctx-1'});
    const all = await listDialogsByProfile(p.id);
    const fresh = all.find(d => d.id === created!.id)!;
    expect(fresh.contextId).toBe('ctx-1');
  });
});
