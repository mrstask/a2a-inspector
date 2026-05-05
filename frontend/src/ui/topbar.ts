import type {AgentProfile, CustomHeader} from '../state/types';
import {
  deleteProfile,
  getProfile,
  listProfiles,
  upsertProfile,
} from '../storage/profiles';
import {deleteDialogsByProfile} from '../storage/dialogs';
import {
  getLastProfileId,
  setLastProfileId,
} from '../storage/prefs';

export interface TopbarSnapshot {
  agentCardUrl: string;
  customHeaders: CustomHeader[];
}

export interface TopbarHooks {
  /** Push values from a profile into the existing form DOM. */
  loadIntoForm: (snapshot: TopbarSnapshot) => void;
  /** Pull current form values for "Save profile". */
  readFromForm: () => TopbarSnapshot;
}

export interface MountedTopbar {
  getActiveProfileId: () => string | null;
  refresh: () => Promise<void>;
  /** Slot elements consumers can append relocated DOM into. */
  slots: {
    url: HTMLElement;
    connect: HTMLElement;
    theme: HTMLElement;
    headersPanel: HTMLElement;
  };
  /** Update the connection status pill. */
  setConnectionStatus: (
    status: 'idle' | 'connected' | 'error',
    message?: string,
  ) => void;
  closeConnectionPopup: () => void;
}

const TEMPLATE = `
  <div class="topbar-row">
    <div class="topbar-brand" aria-label="A2A Inspector">
      <span class="topbar-brand-mark">A2A</span>
      <span class="topbar-brand-name">Inspector</span>
    </div>
    <div class="topbar-current">
      <span class="topbar-current-label">Connection</span>
      <span id="topbar-current-name" class="topbar-current-name">No connection selected</span>
    </div>
    <span id="topbar-status" class="topbar-status" aria-live="polite" data-status="idle">Idle</span>
    <div class="topbar-spacer"></div>
    <button type="button" id="topbar-connection-btn" class="topbar-btn topbar-btn-primary">Connections</button>
    <div class="topbar-theme-slot" data-slot="theme"></div>
  </div>
  <div class="connection-modal" id="topbar-connection-modal" hidden>
    <div class="connection-modal-panel" role="dialog" aria-modal="true" aria-labelledby="connection-modal-title">
      <div class="connection-modal-header">
        <div>
          <h2 id="connection-modal-title">Agent connection</h2>
          <p>Create or edit the endpoint used by the inspector.</p>
        </div>
        <button type="button" id="topbar-close-btn" class="topbar-icon-btn" aria-label="Close connection popup">×</button>
      </div>
      <div class="connection-modal-body">
        <label class="connection-field">
          <span>Saved connection</span>
          <select id="topbar-profile-select" class="topbar-select" aria-label="Saved connection"></select>
        </label>
        <label class="connection-field">
          <span>Name</span>
          <input id="topbar-profile-name" class="topbar-input" type="text" placeholder="Local assistant" aria-label="Connection name" />
        </label>
        <label class="connection-field">
          <span>URL</span>
          <div class="topbar-url-slot" data-slot="url"></div>
        </label>
        <div class="connection-auth-slot" data-slot="headersPanel"></div>
      </div>
      <div class="connection-modal-actions">
        <button type="button" id="topbar-new-btn" class="topbar-btn">Clear</button>
        <button type="button" id="topbar-delete-btn" class="topbar-btn topbar-btn-danger">Delete</button>
        <button type="button" id="topbar-save-btn" class="topbar-btn">Save</button>
        <div class="topbar-connect-slot" data-slot="connect"></div>
      </div>
    </div>
  </div>
`;

function describeProfile(p: AgentProfile): string {
  return p.isImplicit ? `${p.name} (auto)` : p.name;
}

export async function mountTopbar(
  root: HTMLElement,
  hooks: TopbarHooks,
): Promise<MountedTopbar> {
  root.innerHTML = TEMPLATE;
  const select = root.querySelector<HTMLSelectElement>(
    '#topbar-profile-select',
  )!;
  const connectionBtn = root.querySelector<HTMLButtonElement>(
    '#topbar-connection-btn',
  )!;
  const modal = root.querySelector<HTMLDivElement>(
    '#topbar-connection-modal',
  )!;
  const modalPanel = root.querySelector<HTMLDivElement>(
    '.connection-modal-panel',
  )!;
  const closeBtn = root.querySelector<HTMLButtonElement>(
    '#topbar-close-btn',
  )!;
  const nameInput = root.querySelector<HTMLInputElement>(
    '#topbar-profile-name',
  )!;
  const newBtn = root.querySelector<HTMLButtonElement>('#topbar-new-btn')!;
  const saveBtn = root.querySelector<HTMLButtonElement>('#topbar-save-btn')!;
  const deleteBtn = root.querySelector<HTMLButtonElement>(
    '#topbar-delete-btn',
  )!;
  const status = root.querySelector<HTMLSpanElement>('#topbar-status')!;
  const currentName = root.querySelector<HTMLSpanElement>(
    '#topbar-current-name',
  )!;

  const slots = {
    url: root.querySelector<HTMLElement>('[data-slot="url"]')!,
    connect: root.querySelector<HTMLElement>('[data-slot="connect"]')!,
    theme: root.querySelector<HTMLElement>('[data-slot="theme"]')!,
    headersPanel: root.querySelector<HTMLElement>('[data-slot="headersPanel"]')!,
  };

  let activeId: string | null = null;
  let profiles: AgentProfile[] = [];

  function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
    if (msg) {
      status.textContent = msg;
      status.dataset.status = kind === 'error' ? 'error' : 'info';
      window.setTimeout(() => {
        if (status.textContent === msg) {
          status.textContent = activeId ? 'Idle' : 'Idle';
          status.dataset.status = 'idle';
        }
      }, 2500);
    }
  }

  function renderOptions() {
    select.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select profile —';
    select.appendChild(blank);
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = describeProfile(p);
      select.appendChild(opt);
    }
    select.value = activeId ?? '';
  }

  async function refresh(): Promise<void> {
    profiles = await listProfiles();
    profiles.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    renderOptions();
  }

  function applyProfile(p: AgentProfile): void {
    activeId = p.id;
    setLastProfileId(p.id);
    nameInput.value = p.name;
    currentName.textContent = p.name;
    hooks.loadIntoForm({
      agentCardUrl: p.agentCardUrl,
      customHeaders: p.customHeaders,
    });
  }

  function clearActive(): void {
    activeId = null;
    setLastProfileId(null);
    nameInput.value = '';
    currentName.textContent = 'New unsaved connection';
    hooks.loadIntoForm({agentCardUrl: '', customHeaders: []});
  }

  function openModal(): void {
    modal.removeAttribute('hidden');
    nameInput.focus();
  }

  function closeModal(): void {
    modal.setAttribute('hidden', '');
  }

  connectionBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) {
      closeModal();
    }
  });
  modalPanel.addEventListener('click', e => e.stopPropagation());

  select.addEventListener('change', async () => {
    const id = select.value;
    if (!id) {
      clearActive();
      return;
    }
    const p = await getProfile(id);
    if (p) {
      applyProfile(p);
      setStatus(`Loaded "${p.name}"`);
    }
  });

  newBtn.addEventListener('click', () => {
    clearActive();
    renderOptions();
    setStatus('Fill connection details');
    openModal();
  });

  saveBtn.addEventListener('click', async () => {
    const snapshot = hooks.readFromForm();
    const name = nameInput.value.trim() || snapshot.agentCardUrl;
    if (!snapshot.agentCardUrl) {
      setStatus('URL required to save profile', 'error');
      return;
    }
    if (!name) {
      setStatus('Name required', 'error');
      return;
    }
    const existing = activeId ? await getProfile(activeId) : undefined;
    const saved = await upsertProfile({
      ...(existing ?? {}),
      name,
      agentCardUrl: snapshot.agentCardUrl,
      authType: existing?.authType ?? 'none',
      authConfig: existing?.authConfig ?? {},
      customHeaders: snapshot.customHeaders,
      defaultMetadata: existing?.defaultMetadata ?? [],
      isImplicit: false,
    });
    activeId = saved.id;
    currentName.textContent = saved.name;
    setLastProfileId(saved.id);
    await refresh();
    setStatus(`Saved "${saved.name}"`);
  });

  deleteBtn.addEventListener('click', async () => {
    if (!activeId) {
      setStatus('No profile selected', 'error');
      return;
    }
    const p = await getProfile(activeId);
    const name = p?.name ?? 'profile';
    if (!confirm(`Delete profile "${name}" and its saved dialogs?`)) return;
    const idToDelete = activeId;
    await deleteDialogsByProfile(idToDelete);
    await deleteProfile(idToDelete);
    clearActive();
    await refresh();
    setStatus(`Deleted "${name}"`);
  });

  await refresh();

  const lastId = getLastProfileId();
  if (lastId) {
    const p = await getProfile(lastId);
    if (p) {
      applyProfile(p);
      renderOptions();
    }
  }

  return {
    getActiveProfileId: () => activeId,
    refresh,
    slots,
    closeConnectionPopup: closeModal,
    setConnectionStatus: (
      st: 'idle' | 'connected' | 'error',
      message?: string,
    ) => {
      status.dataset.status = st;
      if (st === 'connected') {
        status.textContent = message ?? 'Connected';
      } else if (st === 'error') {
        status.textContent = message ?? 'Error';
      } else {
        status.textContent = message ?? 'Idle';
      }
    },
  };
}
