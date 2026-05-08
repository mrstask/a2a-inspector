import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DB_NAME, resetForTests} from '../../src/storage/db';
import {mountTopbar} from '../../src/ui/topbar';
import {listProfiles, upsertProfile} from '../../src/storage/profiles';

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

function makeRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  return document.getElementById('root')!;
}

describe('ui/topbar', () => {
  beforeEach(async () => {
    await wipe();
  });

  it('renders an empty profile list initially', async () => {
    const root = makeRoot();
    const hooks = {
      loadIntoForm: vi.fn(),
      readFromForm: vi.fn(() => ({agentCardUrl: '', customHeaders: []})),
    };
    await mountTopbar(root, hooks);
    const select = root.querySelector('select')!;
    // 1 placeholder option, no profiles
    expect(select.querySelectorAll('option')).toHaveLength(1);
  });

  it('lists existing profiles after mount', async () => {
    await upsertProfile({
      name: 'Alpha',
      agentCardUrl: 'http://a',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    const root = makeRoot();
    await mountTopbar(root, {
      loadIntoForm: vi.fn(),
      readFromForm: vi.fn(() => ({agentCardUrl: '', customHeaders: []})),
    });
    const select = root.querySelector('select')!;
    expect(select.querySelectorAll('option')).toHaveLength(2);
    expect(select.options[1].textContent).toContain('Alpha');
  });

  it('Save creates a new profile from form values', async () => {
    const root = makeRoot();
    const readFromForm = vi.fn(() => ({
      agentCardUrl: 'http://saveme:5555',
      customHeaders: [{name: 'X', value: 'Y'}],
    }));
    await mountTopbar(root, {
      loadIntoForm: vi.fn(),
      readFromForm,
    });
    const nameInput = root.querySelector<HTMLInputElement>(
      '#topbar-profile-name',
    )!;
    nameInput.value = 'Saved one';
    const saveBtn = root.querySelector<HTMLButtonElement>(
      '#topbar-save-btn',
    )!;
    saveBtn.click();
    // wait microtasks
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const all = await listProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Saved one');
    expect(all[0].agentCardUrl).toBe('http://saveme:5555');
    expect(all[0].customHeaders).toEqual([{name: 'X', value: 'Y'}]);
    expect(all[0].isImplicit).toBe(false);
  });

  it('selecting a profile loads it into the form', async () => {
    const p = await upsertProfile({
      name: 'Loadme',
      agentCardUrl: 'http://load',
      authType: 'none',
      authConfig: {},
      customHeaders: [{name: 'A', value: 'B'}],
      defaultMetadata: [],
    });
    const loadIntoForm = vi.fn();
    const root = makeRoot();
    await mountTopbar(root, {
      loadIntoForm,
      readFromForm: vi.fn(() => ({agentCardUrl: '', customHeaders: []})),
    });
    const select = root.querySelector<HTMLSelectElement>(
      '#topbar-inline-select',
    )!;
    select.value = p.id;
    select.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(loadIntoForm).toHaveBeenCalledWith({
      agentCardUrl: 'http://load',
      customHeaders: [{name: 'A', value: 'B'}],
    });
  });

  it('restores last active profile on mount', async () => {
    const p = await upsertProfile({
      name: 'Sticky',
      agentCardUrl: 'http://sticky',
      authType: 'none',
      authConfig: {},
      customHeaders: [],
      defaultMetadata: [],
    });
    localStorage.setItem('a2a-inspector:lastProfileId', p.id);
    const loadIntoForm = vi.fn();
    const root = makeRoot();
    const t = await mountTopbar(root, {
      loadIntoForm,
      readFromForm: vi.fn(() => ({agentCardUrl: '', customHeaders: []})),
    });
    expect(t.getActiveProfileId()).toBe(p.id);
    expect(loadIntoForm).toHaveBeenCalledWith({
      agentCardUrl: 'http://sticky',
      customHeaders: [],
    });
  });
});
