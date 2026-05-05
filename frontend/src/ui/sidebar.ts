import type {SavedDialog} from '../state/types';
import {
  createDialog,
  deleteDialog,
  deriveDialogTitle,
  getDialog,
  listDialogsByProfile,
  patchDialog,
} from '../storage/dialogs';

export interface SidebarHooks {
  /** Returns the active profile id (or null if none). */
  getActiveProfileId: () => string | null;
  /** Replay a saved dialog into the chat/debug DOM. */
  loadDialog: (dialog: SavedDialog) => void;
  /** Reset chat/debug DOM (for new dialog). */
  resetChat: () => void;
}

export interface MountedSidebar {
  getActiveDialogId: () => string | null;
  setActiveDialogId: (id: string | null) => void;
  /** Create a fresh dialog under the active profile and select it. */
  createDialogForActiveProfile: (title?: string) => Promise<SavedDialog | null>;
  /** Refresh the dialog list (after external writes). */
  refresh: () => Promise<void>;
  /** Bump the active dialog's title or contextId via partial update. */
  updateActiveDialog: (
    patch: Partial<Pick<SavedDialog, 'title' | 'contextId'>>,
  ) => Promise<void>;
}

const TEMPLATE = `
  <div class="sidebar-header">
    <div>
      <span class="sidebar-title">Dialogs</span>
      <span class="sidebar-subtitle">Saved per profile</span>
    </div>
    <button type="button" id="sidebar-new-dialog" class="sidebar-icon-btn" title="New dialog">+</button>
  </div>
  <ul id="sidebar-dialog-list" class="sidebar-list"></ul>
  <div class="sidebar-empty" id="sidebar-empty">No profile selected.</div>
`;

function describeDialog(d: SavedDialog): string {
  const count = d.messages.length;
  const title = deriveDialogTitle(d);
  return count > 0 ? `${title} (${count})` : title;
}

function defaultDialogTitle(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `Dialog @ ${hh}:${mm}`;
}

export async function mountSidebar(
  root: HTMLElement,
  hooks: SidebarHooks,
): Promise<MountedSidebar> {
  root.innerHTML = TEMPLATE;
  const list = root.querySelector<HTMLUListElement>(
    '#sidebar-dialog-list',
  )!;
  const empty = root.querySelector<HTMLDivElement>('#sidebar-empty')!;
  const newBtn = root.querySelector<HTMLButtonElement>(
    '#sidebar-new-dialog',
  )!;

  let dialogs: SavedDialog[] = [];
  let activeDialogId: string | null = null;

  function renderList(): void {
    list.innerHTML = '';
    const profileId = hooks.getActiveProfileId();
    if (!profileId) {
      empty.textContent = 'No profile selected. Save or select a profile to keep dialogs here.';
      empty.style.display = 'block';
      return;
    }
    if (dialogs.length === 0) {
      empty.textContent = 'No saved dialogs yet.';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    for (const d of dialogs) {
      const li = document.createElement('li');
      li.className = 'sidebar-item';
      if (d.id === activeDialogId) li.classList.add('is-active');
      li.dataset.dialogId = d.id;

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'sidebar-item-label';
      label.textContent = describeDialog(d);
      label.addEventListener('click', () => selectDialog(d.id));
      li.appendChild(label);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sidebar-item-del';
      del.title = 'Delete dialog';
      del.textContent = '×';
      del.addEventListener('click', e => {
        e.stopPropagation();
        void removeDialog(d.id);
      });
      li.appendChild(del);

      list.appendChild(li);
    }
  }

  async function refresh(): Promise<void> {
    const profileId = hooks.getActiveProfileId();
    if (!profileId) {
      dialogs = [];
      renderList();
      return;
    }
    dialogs = await listDialogsByProfile(profileId);
    dialogs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    renderList();
  }

  async function selectDialog(id: string): Promise<void> {
    const d = await getDialog(id);
    if (!d) return;
    activeDialogId = d.id;
    hooks.loadDialog(d);
    renderList();
  }

  async function removeDialog(id: string): Promise<void> {
    const d = dialogs.find(x => x.id === id);
    if (!d) return;
    if (!confirm(`Delete dialog "${d.title}"?`)) return;
    await deleteDialog(id);
    if (activeDialogId === id) {
      activeDialogId = null;
      hooks.resetChat();
    }
    await refresh();
  }

  async function createDialogForActiveProfile(
    title?: string,
  ): Promise<SavedDialog | null> {
    const profileId = hooks.getActiveProfileId();
    if (!profileId) return null;
    const d = await createDialog({
      profileId,
      title: title ?? defaultDialogTitle(),
    });
    activeDialogId = d.id;
    hooks.resetChat();
    await refresh();
    return d;
  }

  newBtn.addEventListener('click', () => {
    void createDialogForActiveProfile();
  });

  await refresh();

  return {
    getActiveDialogId: () => activeDialogId,
    setActiveDialogId: id => {
      activeDialogId = id;
      renderList();
    },
    createDialogForActiveProfile,
    refresh,
    updateActiveDialog: async patch => {
      if (!activeDialogId) return;
      await patchDialog(activeDialogId, patch);
      await refresh();
    },
  };
}
