export type AuthType = 'none' | 'bearer' | 'basic' | 'api-key';

export interface CustomHeader {
  name: string;
  value: string;
}

export interface DefaultMetadataEntry {
  key: string;
  value: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  agentCardUrl: string;
  description?: string;
  tags?: string[];
  authType: AuthType;
  authConfig: {
    headerName?: string;
    username?: string;
  };
  customHeaders: CustomHeader[];
  defaultMetadata: DefaultMetadataEntry[];
  isImplicit?: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
  lastDialogId?: string;
}

export type ChatRole = 'user' | 'agent' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  kind?: string;
  html?: string;
  text?: string;
  validationErrors?: string[];
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type DebugDirection = 'request' | 'response' | 'event' | 'error' | 'validation_error';

export interface DebugEvent {
  id: string;
  direction: DebugDirection;
  method?: string;
  payload: unknown;
  correlationId?: string;
  createdAt: string;
}

export interface SavedDialog {
  id: string;
  profileId: string;
  title: string;
  contextId?: string | null;
  messages: ChatMessage[];
  debugEvents: DebugEvent[];
  agentCardSnapshot?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface InspectorExport {
  version: number;
  exportedAt: string;
  profiles: AgentProfile[];
  dialogs: SavedDialog[];
}
