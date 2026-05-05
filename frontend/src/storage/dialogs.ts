import type {ChatMessage, DebugEvent, SavedDialog} from '../state/types';
import {
  STORE_DIALOGS,
  nowIso,
  reqAsPromise,
  runTx,
  uuid,
} from './db';

export type NewDialogInput = Omit<
  SavedDialog,
  'id' | 'createdAt' | 'updatedAt' | 'messages' | 'debugEvents'
> &
  Partial<
    Pick<
      SavedDialog,
      'id' | 'createdAt' | 'updatedAt' | 'messages' | 'debugEvents'
    >
  >;

const dialogWriteQueues = new Map<string, Promise<void>>();
const DEFAULT_DIALOG_TITLE_RE = /^Dialog @ \d{2}:\d{2}$/;
const MAX_DIALOG_TITLE_LENGTH = 42;

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateTitle(value: string): string {
  const normalized = compactText(value);
  if (normalized.length <= MAX_DIALOG_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_DIALOG_TITLE_LENGTH - 3).trimEnd()}...`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function attachmentName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const name = (value as {name?: unknown}).name;
  return typeof name === 'string' && name.trim() ? name : null;
}

export function isDefaultDialogTitle(title: string): boolean {
  return DEFAULT_DIALOG_TITLE_RE.test(title);
}

export function titleFromChatMessage(message: ChatMessage): string | null {
  const text = compactText(message.text ?? stripHtml(message.html ?? ''));
  if (text) return truncateTitle(text);

  const names = (message.attachments ?? [])
    .map(attachmentName)
    .filter((name): name is string => Boolean(name));
  if (names.length > 0) return truncateTitle(names.join(', '));

  return null;
}

export function deriveDialogTitle(dialog: SavedDialog): string {
  if (!isDefaultDialogTitle(dialog.title)) return dialog.title;
  const firstUserTitle = dialog.messages
    .filter(message => message.role === 'user')
    .map(titleFromChatMessage)
    .find((title): title is string => Boolean(title));
  return firstUserTitle ?? dialog.title;
}

function enqueueDialogMutation(
  dialogId: string,
  mutation: () => Promise<void>,
): Promise<void> {
  const previous = dialogWriteQueues.get(dialogId) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      /* Keep later writes moving even if an earlier write failed. */
    })
    .then(mutation)
    .finally(() => {
      if (dialogWriteQueues.get(dialogId) === next) {
        dialogWriteQueues.delete(dialogId);
      }
    });
  dialogWriteQueues.set(dialogId, next);
  return next;
}

export async function listDialogsByProfile(
  profileId: string,
): Promise<SavedDialog[]> {
  return runTx(STORE_DIALOGS, 'readonly', tx => {
    const store = tx.objectStore(STORE_DIALOGS);
    const idx = store.index('byProfileId');
    return reqAsPromise(
      idx.getAll(profileId) as IDBRequest<SavedDialog[]>,
    );
  });
}

export async function getDialog(id: string): Promise<SavedDialog | undefined> {
  return runTx(STORE_DIALOGS, 'readonly', tx => {
    return reqAsPromise(
      tx.objectStore(STORE_DIALOGS).get(id) as IDBRequest<
        SavedDialog | undefined
      >,
    );
  });
}

export async function createDialog(
  input: NewDialogInput,
): Promise<SavedDialog> {
  const now = nowIso();
  const dialog: SavedDialog = {
    id: input.id ?? uuid(),
    profileId: input.profileId,
    title: input.title,
    contextId: input.contextId ?? null,
    messages: input.messages ?? [],
    debugEvents: input.debugEvents ?? [],
    agentCardSnapshot: input.agentCardSnapshot,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  await runTx(STORE_DIALOGS, 'readwrite', tx => {
    tx.objectStore(STORE_DIALOGS).put(dialog);
  });
  return dialog;
}

export async function updateDialog(
  dialog: SavedDialog,
): Promise<SavedDialog> {
  const next: SavedDialog = {...dialog, updatedAt: nowIso()};
  await enqueueDialogMutation(dialog.id, () =>
    runTx(STORE_DIALOGS, 'readwrite', tx => {
      tx.objectStore(STORE_DIALOGS).put(next);
    }),
  );
  return next;
}

export async function patchDialog(
  dialogId: string,
  patch: Partial<Omit<SavedDialog, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<SavedDialog | undefined> {
  let next: SavedDialog | undefined;
  await enqueueDialogMutation(dialogId, async () => {
    await runTx(STORE_DIALOGS, 'readwrite', async tx => {
      const store = tx.objectStore(STORE_DIALOGS);
      const dialog = await reqAsPromise(
        store.get(dialogId) as IDBRequest<SavedDialog | undefined>,
      );
      if (!dialog) return;
      next = {...dialog, ...patch, id: dialog.id, updatedAt: nowIso()};
      store.put(next);
    });
  });
  return next;
}

export async function deleteDialog(id: string): Promise<void> {
  await runTx(STORE_DIALOGS, 'readwrite', tx => {
    tx.objectStore(STORE_DIALOGS).delete(id);
  });
}

export async function deleteDialogsByProfile(
  profileId: string,
): Promise<void> {
  await runTx(STORE_DIALOGS, 'readwrite', async tx => {
    const idx = tx.objectStore(STORE_DIALOGS).index('byProfileId');
    const keys = await reqAsPromise(
      idx.getAllKeys(profileId) as IDBRequest<IDBValidKey[]>,
    );
    for (const key of keys) {
      tx.objectStore(STORE_DIALOGS).delete(key);
    }
  });
}

export async function appendMessage(
  dialogId: string,
  message: ChatMessage,
): Promise<void> {
  await enqueueDialogMutation(dialogId, () =>
    runTx(STORE_DIALOGS, 'readwrite', async tx => {
      const store = tx.objectStore(STORE_DIALOGS);
      const dialog = await reqAsPromise(
        store.get(dialogId) as IDBRequest<SavedDialog | undefined>,
      );
      if (!dialog) return;
      if (
        message.role === 'user' &&
        isDefaultDialogTitle(dialog.title) &&
        !dialog.messages.some(
          existing =>
            existing.role === 'user' && titleFromChatMessage(existing),
        )
      ) {
        const title = titleFromChatMessage(message);
        if (title) dialog.title = title;
      }
      dialog.messages.push(message);
      dialog.updatedAt = nowIso();
      store.put(dialog);
    }),
  );
}

export async function appendDebugEvent(
  dialogId: string,
  event: DebugEvent,
): Promise<void> {
  await enqueueDialogMutation(dialogId, () =>
    runTx(STORE_DIALOGS, 'readwrite', async tx => {
      const store = tx.objectStore(STORE_DIALOGS);
      const dialog = await reqAsPromise(
        store.get(dialogId) as IDBRequest<SavedDialog | undefined>,
      );
      if (!dialog) return;
      dialog.debugEvents.push(event);
      dialog.updatedAt = nowIso();
      store.put(dialog);
    }),
  );
}
