const PREFIX = 'a2a-inspector:';

const KEY_LAST_PROFILE = PREFIX + 'lastProfileId';
const KEY_ACTIVE_TAB = PREFIX + 'activeTab';
const KEY_SIDEBAR_COLLAPSED = PREFIX + 'sidebarCollapsed';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota exceeded or unavailable */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* unavailable */
  }
}

export function getLastProfileId(): string | null {
  return safeGet(KEY_LAST_PROFILE);
}

export function setLastProfileId(id: string | null): void {
  if (id === null) {
    safeRemove(KEY_LAST_PROFILE);
  } else {
    safeSet(KEY_LAST_PROFILE, id);
  }
}

export function getActiveTab(): string | null {
  return safeGet(KEY_ACTIVE_TAB);
}

export function setActiveTab(tab: string): void {
  safeSet(KEY_ACTIVE_TAB, tab);
}

export function getSidebarCollapsed(): boolean {
  return safeGet(KEY_SIDEBAR_COLLAPSED) === '1';
}

export function setSidebarCollapsed(collapsed: boolean): void {
  safeSet(KEY_SIDEBAR_COLLAPSED, collapsed ? '1' : '0');
}
