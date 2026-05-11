import type {AgentProfile} from '../state/types';
import {
  STORE_PROFILES,
  nowIso,
  reqAsPromise,
  runTx,
  uuid,
} from './db';

export type NewProfileInput = Omit<
  AgentProfile,
  'id' | 'createdAt' | 'updatedAt'
> &
  Partial<Pick<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>>;

export async function listProfiles(): Promise<AgentProfile[]> {
  return runTx(STORE_PROFILES, 'readonly', tx => {
    const store = tx.objectStore(STORE_PROFILES);
    return reqAsPromise(store.getAll() as IDBRequest<AgentProfile[]>);
  });
}

export async function getProfile(id: string): Promise<AgentProfile | undefined> {
  return runTx(STORE_PROFILES, 'readonly', tx => {
    const store = tx.objectStore(STORE_PROFILES);
    return reqAsPromise(
      store.get(id) as IDBRequest<AgentProfile | undefined>,
    );
  });
}

export async function upsertProfile(
  input: NewProfileInput,
): Promise<AgentProfile> {
  const now = nowIso();
  const profile: AgentProfile = {
    id: input.id ?? uuid(),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    name: input.name,
    agentCardUrl: input.agentCardUrl,
    description: input.description,
    tags: input.tags,
    authType: input.authType,
    authConfig: input.authConfig,
    customHeaders: input.customHeaders,
    defaultMetadata: input.defaultMetadata,
    routeThroughAgentUrl: input.routeThroughAgentUrl,
    isImplicit: input.isImplicit,
    lastConnectedAt: input.lastConnectedAt,
    lastDialogId: input.lastDialogId,
  };
  await runTx(STORE_PROFILES, 'readwrite', tx => {
    tx.objectStore(STORE_PROFILES).put(profile);
  });
  return profile;
}

export async function deleteProfile(id: string): Promise<void> {
  await runTx(STORE_PROFILES, 'readwrite', tx => {
    tx.objectStore(STORE_PROFILES).delete(id);
  });
}

export async function findByUrl(
  agentCardUrl: string,
): Promise<AgentProfile | undefined> {
  const all = await listProfiles();
  return all.find(p => p.agentCardUrl === agentCardUrl);
}

export async function upsertImplicit(
  agentCardUrl: string,
  customHeaders: Record<string, string> = {},
  routeThroughAgentUrl: boolean = false,
): Promise<AgentProfile> {
  const existing = await findByUrl(agentCardUrl);
  const headers = Object.entries(customHeaders).map(([name, value]) => ({
    name,
    value,
  }));
  const now = nowIso();
  if (existing) {
    return upsertProfile({
      ...existing,
      routeThroughAgentUrl,
      lastConnectedAt: now,
    });
  }
  return upsertProfile({
    name: agentCardUrl,
    agentCardUrl,
    authType: 'none',
    authConfig: {},
    customHeaders: headers,
    defaultMetadata: [],
    routeThroughAgentUrl,
    isImplicit: true,
    lastConnectedAt: now,
  });
}
