import type {AgentProfile, SavedDialog} from './types';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  activeUrl?: string;
  transport?: string;
  inputModes: string[];
  outputModes: string[];
  agentCard?: unknown;
  error?: string;
}

export type ActiveTab =
  | 'chat'
  | 'agentCard'
  | 'debug'
  | 'rawJson'
  | 'settings';

export interface UiState {
  sidebarCollapsed: boolean;
  activeTab: ActiveTab;
  density: 'comfortable' | 'compact';
  theme: 'light' | 'dark';
}

export interface AuthSecret {
  token?: string;
  password?: string;
  apiKeyValue?: string;
}

export interface AppState {
  profiles: AgentProfile[];
  dialogs: SavedDialog[];
  activeProfileId: string | null;
  activeDialogId: string | null;
  connection: ConnectionState;
  ui: UiState;
  ephemeral: {
    secrets: Map<string, AuthSecret>;
  };
}

type Listener = (state: AppState) => void;
type Selector<T> = (state: AppState) => T;
type Patch = Partial<AppState> | ((state: AppState) => Partial<AppState>);

const initialState: AppState = {
  profiles: [],
  dialogs: [],
  activeProfileId: null,
  activeDialogId: null,
  connection: {
    status: 'idle',
    inputModes: [],
    outputModes: [],
  },
  ui: {
    sidebarCollapsed: false,
    activeTab: 'chat',
    density: 'compact',
    theme: 'light',
  },
  ephemeral: {
    secrets: new Map(),
  },
};

export function createStore(seed: AppState = initialState) {
  let state: AppState = seed;
  const listeners = new Set<Listener>();

  function getState(): AppState {
    return state;
  }

  function setState(patch: Patch): void {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next || Object.keys(next).length === 0) return;
    state = {...state, ...next};
    for (const l of listeners) l(state);
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function select<T>(
    selector: Selector<T>,
    listener: (value: T, prev: T) => void,
  ): () => void {
    let prev = selector(state);
    return subscribe(s => {
      const next = selector(s);
      if (!Object.is(next, prev)) {
        const old = prev;
        prev = next;
        listener(next, old);
      }
    });
  }

  return {getState, setState, subscribe, select};
}

export type Store = ReturnType<typeof createStore>;

export const store: Store = createStore();
