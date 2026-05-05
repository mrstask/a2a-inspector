import {getActiveTab, setActiveTab} from '../storage/prefs';

export type TabId =
  | 'chat'
  | 'agentCard'
  | 'sessionDetails'
  | 'metadata'
  | 'rawJson'
  | 'tools'
  | 'headers'
  | 'debug';

const VALID_TABS: TabId[] = [
  'chat',
  'agentCard',
  'sessionDetails',
  'metadata',
  'rawJson',
  'tools',
  'headers',
  'debug',
];

export interface MountedTabs {
  setActive: (tab: TabId) => void;
  getActive: () => TabId;
}

export interface TabDefinition {
  id: TabId;
  label: string;
}

export interface MountTabsOptions {
  tabs?: TabDefinition[];
  storageKey?: string;
}

/**
 * Mounts a tab strip. Each panel must be an existing element with
 * `data-tab="..."`. The strip
 * itself is built into `barRoot`.
 */
export function mountTabs(
  barRoot: HTMLElement,
  options: MountTabsOptions = {},
): MountedTabs {
  const configuredTabs = options.tabs ?? [
    {id: 'chat' as TabId, label: 'Chat'},
    {id: 'agentCard' as TabId, label: 'Agent Card'},
    {id: 'sessionDetails' as TabId, label: 'Session'},
    {id: 'metadata' as TabId, label: 'Metadata'},
    {id: 'debug' as TabId, label: 'Debug'},
  ];
  const validTabs = configuredTabs.map(t => t.id);
  barRoot.innerHTML = configuredTabs
    .map(
      t =>
        `<button type="button" class="tab-btn" data-tab="${t.id}">${t.label}</button>`,
    )
    .join('');
  const buttons = Array.from(
    barRoot.querySelectorAll<HTMLButtonElement>('.tab-btn'),
  );
  const panels = Array.from(
    document.querySelectorAll<HTMLElement>('[data-tab]'),
  ).filter(el => !el.classList.contains('tab-btn'));

  const stored = options.storageKey
    ? localStorage.getItem(options.storageKey)
    : getActiveTab();
  let current: TabId = (stored as TabId) ?? configuredTabs[0].id;
  if (!VALID_TABS.includes(current) || !validTabs.includes(current)) {
    current = configuredTabs[0].id;
  }

  function apply(tab: TabId): void {
    current = tab;
    if (options.storageKey) {
      localStorage.setItem(options.storageKey, tab);
    } else {
      setActiveTab(tab);
    }
    for (const btn of buttons) {
      btn.classList.toggle('is-active', btn.dataset.tab === tab);
    }
    for (const panel of panels) {
      panel.classList.toggle('is-active', panel.dataset.tab === tab);
    }
  }

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as TabId;
      if (VALID_TABS.includes(tab)) apply(tab);
    });
  }

  apply(current);

  return {
    setActive: apply,
    getActive: () => current,
  };
}
