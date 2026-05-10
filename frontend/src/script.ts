import {io} from 'socket.io-client';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import {upsertImplicit, upsertProfile, getProfile} from './storage/profiles';
import {isAvailable as idbAvailable} from './storage/db';
import {setLastProfileId} from './storage/prefs';
import {mountTopbar, type MountedTopbar} from './ui/topbar';
import {showReauthDialog} from './ui/reauth-dialog';
import {mountSidebar, type MountedSidebar} from './ui/sidebar';
import {
  appendDebugEvent as dbAppendDebug,
  appendMessage as dbAppendMessage,
} from './storage/dialogs';
import type {ChatMessage, DebugEvent, SavedDialog} from './state/types';

// A2A File types (matching spec)
interface FileBase {
  name?: string;
  mimeType?: string;
}

interface FileWithBytes extends FileBase {
  bytes: string;
  uri?: never;
}

interface FileWithUri extends FileBase {
  uri: string;
  bytes?: never;
}

type FileContent = FileWithBytes | FileWithUri;

type AnyPart =
  | {kind?: string; text?: string}
  | {kind?: string; file?: FileContent}
  | {kind?: string; data?: unknown};

interface UiToolCallPayload {
  name?: string;
  args?: Record<string, unknown>;
}

interface AgentResponseEvent {
  kind: 'task' | 'status-update' | 'artifact-update' | 'message';
  id: string;
  contextId?: string;
  error?: string;
  status?: {
    state: string;
    message?: {parts?: AnyPart[]};
  };
  artifact?: {
    parts?: AnyPart[];
  };
  artifacts?: Array<{
    artifactId?: string;
    name?: string;
    description?: string;
    metadata?: object;
    parts?: AnyPart[];
  }>;
  parts?: AnyPart[];
  validation_errors: string[];
}

interface DebugLog {
  type: 'request' | 'response' | 'error' | 'validation_error';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  id: string;
}

// Declare hljs global from CDN
declare global {
  interface Window {
    hljs: {
      highlightElement: (element: HTMLElement) => void;
    };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Phase 4: layout-v2 is now the default. `?v2=0` opts out as an escape hatch.
  const LAYOUT_V2_OPT_OUT_KEY = 'a2a-inspector:layoutV2OptOut';
  const params = new URLSearchParams(window.location.search);
  if (params.get('v2') === '0') {
    try {
      localStorage.setItem(LAYOUT_V2_OPT_OUT_KEY, '1');
    } catch {
      /* ignore */
    }
  } else if (params.get('v2') === '1') {
    try {
      localStorage.removeItem(LAYOUT_V2_OPT_OUT_KEY);
    } catch {
      /* ignore */
    }
  }
  let optedOut = false;
  try {
    optedOut = localStorage.getItem(LAYOUT_V2_OPT_OUT_KEY) === '1';
  } catch {
    /* ignore */
  }
  const layoutV2 = !optedOut;
  if (layoutV2) {
    document.body.classList.add('layout-v2');
    const topbarRoot = document.getElementById('topbar-root');
    if (topbarRoot) topbarRoot.removeAttribute('hidden');
    const rightRail = document.getElementById('right-rail');
    if (rightRail) rightRail.removeAttribute('hidden');
  }

  let topbar: MountedTopbar | null = null;
  let sidebar: MountedSidebar | null = null;
  let isReplaying = false;

  const INITIALIZATION_TIMEOUT_MS = 10000;
  const MAX_LOGS = 500;

  const themeCheckbox = document.getElementById(
    'theme-checkbox',
  ) as HTMLInputElement;
  const highlightLight = document.getElementById(
    'highlight-light',
  ) as HTMLLinkElement;
  const highlightDark = document.getElementById(
    'highlight-dark',
  ) as HTMLLinkElement;

  const updateSyntaxHighlighting = (isDark: boolean) => {
    if (isDark) {
      highlightLight.disabled = true;
      highlightDark.disabled = false;
    } else {
      highlightLight.disabled = false;
      highlightDark.disabled = true;
    }
  };

  themeCheckbox.addEventListener('change', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateSyntaxHighlighting(isDark);
  });
  const connectBtn = document.getElementById(
    'connect-btn',
  ) as HTMLButtonElement;
  const agentCardUrlInput = document.getElementById(
    'agent-card-url',
  ) as HTMLInputElement;
  const httpHeadersToggle = document.getElementById(
    'http-headers-toggle',
  ) as HTMLElement;
  const httpHeadersContent = document.getElementById(
    'http-headers-content',
  ) as HTMLElement;
  const authTypeSelect = document.getElementById(
    'auth-type',
  ) as HTMLSelectElement;
  const authInputsContainer = document.getElementById(
    'auth-inputs',
  ) as HTMLElement;
  const headersList = document.getElementById('headers-list') as HTMLElement;
  const addHeaderBtn = document.getElementById(
    'add-header-btn',
  ) as HTMLButtonElement;
  const messageMetadataToggle = document.getElementById(
    'message-metadata-toggle',
  ) as HTMLElement;
  const messageMetadataContent = document.getElementById(
    'message-metadata-content',
  ) as HTMLElement;
  const metadataList = document.getElementById('metadata-list') as HTMLElement;
  const addMetadataBtn = document.getElementById(
    'add-metadata-btn',
  ) as HTMLButtonElement;
  const collapsibleHeader = document.querySelector(
    '.collapsible-header',
  ) as HTMLElement;
  const collapsibleContent = document.querySelector(
    '.collapsible-content',
  ) as HTMLElement;
  const agentCardCodeContent = document.getElementById(
    'agent-card-content',
  ) as HTMLElement;
  const validationErrorsContainer = document.getElementById(
    'validation-errors',
  ) as HTMLElement;
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const chatMessages = document.getElementById('chat-messages') as HTMLElement;
  const debugConsole = document.getElementById('debug-console') as HTMLElement;
  const debugHandle = document.getElementById('debug-handle') as HTMLElement;
  const debugContent = document.getElementById('debug-content') as HTMLElement;
  const clearConsoleBtn = document.getElementById(
    'clear-console-btn',
  ) as HTMLButtonElement;
  const toggleConsoleBtn = document.getElementById(
    'toggle-console-btn',
  ) as HTMLButtonElement;
  const jsonModal = document.getElementById('json-modal') as HTMLElement;
  const modalJsonContent = document.getElementById(
    'modal-json-content',
  ) as HTMLPreElement;
  const modalCloseBtn = document.querySelector(
    '.modal-close-btn',
  ) as HTMLElement;
  const newSessionBtn = document.getElementById(
    'new-session-btn',
  ) as HTMLButtonElement;
  const copyDialogBtn = document.getElementById(
    'copy-dialog-btn',
  ) as HTMLButtonElement | null;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const attachBtn = document.getElementById('attach-btn') as HTMLButtonElement;
  const attachmentsPreview = document.getElementById(
    'attachments-preview',
  ) as HTMLElement;
  const requestBodyJson = document.getElementById(
    'request-body-json',
  ) as HTMLTextAreaElement;
  const responseSummary = document.getElementById(
    'response-summary',
  ) as HTMLElement;
  const responseStatus = document.getElementById(
    'response-status',
  ) as HTMLElement;
  const responseTime = document.getElementById('response-time') as HTMLElement;
  const responseSize = document.getElementById('response-size') as HTMLElement;
  const responsePretty = document.getElementById(
    'response-pretty',
  ) as HTMLElement;
  const responseRaw = document.getElementById('response-raw') as HTMLElement;
  const responseTimeline = document.getElementById(
    'response-timeline',
  ) as HTMLElement;
  const responseLogs = document.getElementById('response-logs') as HTMLElement;

  let contextId: string | null = null;
  let isConnected = false;
  let supportedInputModes: string[] = ['text/plain'];
  let supportedOutputModes: string[] = ['text/plain'];
  let isResizing = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLogStore: Record<string, Record<string, any>> = {};
  const messageJsonStore: {[key: string]: AgentResponseEvent} = {};
  const logIdQueue: string[] = [];
  let initializationTimeout: ReturnType<typeof setTimeout>;
  let isProcessingLogQueue = false;
  let lastRequestStartedAt = 0;
  let lastRequestId: string | null = null;

  // Attachment state
  interface Attachment {
    name: string;
    size: number;
    mimeType: string;
    data: string; // base64 encoded
    thumbnail?: string; // for images
  }
  interface MessageDetails {
    kind?: string;
    status?: string;
    transport?: string;
    validation: 'valid' | 'invalid';
    validationErrors?: string[];
  }
  const attachments: Attachment[] = [];

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    const value = bytes / Math.pow(1024, exponent);
    return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[exponent]}`;
  }

  function getSelectedTools(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('.tool-checkbox:checked'),
    ).map(input => input.value);
  }

  function buildRequestDraft(message = chatInput?.value ?? '') {
    const context: Record<string, unknown> = {};
    if (contextId) context.contextId = contextId;
    const metadata = getMessageMetadata();
    if (Object.keys(metadata).length > 0) context.metadata = metadata;
    return {
      message,
      context,
      tools: getSelectedTools(),
    };
  }

  function syncRequestBodyJson(): void {
    if (!requestBodyJson) return;
    requestBodyJson.value = JSON.stringify(buildRequestDraft(), null, 2);
  }

  function appendTimeline(label: string, detail?: string): void {
    const item = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'response-timeline-time';
    time.textContent = new Date().toLocaleTimeString();
    const text = document.createElement('span');
    text.textContent = detail ? `${label}: ${detail}` : label;
    item.appendChild(time);
    item.appendChild(text);
    responseTimeline?.appendChild(item);
  }

  function setResponsePayload(
    payload: unknown,
    status = '200',
    summary = 'Agent response received.',
  ): void {
    const raw = JSON.stringify(payload, null, 2);
    const duration = lastRequestStartedAt
      ? Math.round(performance.now() - lastRequestStartedAt)
      : 0;
    responseSummary.textContent = summary;
    responseStatus.textContent = status;
    responseStatus.dataset.kind =
      status.startsWith('2') || status === 'event' ? 'ok' : 'error';
    responseTime.textContent = `${duration} ms`;
    responseSize.textContent = formatBytes(new Blob([raw]).size);
    responsePretty.textContent = raw;
    responseRaw.textContent = raw;
    if (window.hljs) window.hljs.highlightElement(responsePretty);
    appendTimeline('Response', `${duration} ms`);
  }

  function renderResponseLog(log: DebugLog): void {
    if (!responseLogs) return;
    const entry = document.createElement('div');
    entry.className = `log-entry log-${log.type}`;
    const raw = JSON.stringify(log.data, null, 2);
    entry.innerHTML = `
      <div>
        <span class="log-timestamp">${new Date().toLocaleTimeString()}</span>
        <strong>${log.type.toUpperCase()}</strong>
      </div>
      <pre>${DOMPurify.sanitize(raw)}</pre>
    `;
    responseLogs.appendChild(entry);
    responseLogs.scrollTop = responseLogs.scrollHeight;
  }

  debugHandle.addEventListener('mousedown', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target === debugHandle || target.tagName === 'SPAN') {
      isResizing = true;
      document.body.style.userSelect = 'none';
      document.body.style.pointerEvents = 'none';
    }
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isResizing) return;
    const newHeight = window.innerHeight - e.clientY;
    if (newHeight > 40 && newHeight < window.innerHeight * 0.9) {
      debugConsole.style.height = `${newHeight}px`;
    }
  });

  window.addEventListener('mouseup', () => {
    isResizing = false;
    document.body.style.userSelect = '';
    document.body.style.pointerEvents = '';
  });

  if (collapsibleHeader && collapsibleContent) {
    collapsibleHeader.addEventListener('click', () => {
      collapsibleHeader.classList.toggle('collapsed');
      collapsibleContent.classList.toggle('collapsed');
      collapsibleContent.style.overflow = 'hidden';
    });

    collapsibleContent.addEventListener('transitionend', () => {
      if (!collapsibleContent.classList.contains('collapsed')) {
        collapsibleContent.style.overflow = 'auto';
      }
    });
  }

  function setupToggle(
    toggleElement: HTMLElement,
    contentElement: HTMLElement,
  ) {
    if (!toggleElement || !contentElement) return;
    toggleElement.addEventListener('click', () => {
      const isExpanded = contentElement.classList.toggle('expanded');
      const toggleIcon = toggleElement.querySelector('.toggle-icon');
      if (toggleIcon) {
        toggleIcon.textContent = isExpanded ? '▼' : '►';
      }
    });
  }

  setupToggle(httpHeadersToggle, httpHeadersContent);
  setupToggle(messageMetadataToggle, messageMetadataContent);

  const responseTabButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-response-tab]'),
  );
  const responseViews = Array.from(
    document.querySelectorAll<HTMLElement>('[data-response-view]'),
  );
  responseTabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.dataset.responseTab;
      responseTabButtons.forEach(b =>
        b.classList.toggle('is-active', b === button),
      );
      responseViews.forEach(view =>
        view.classList.toggle('is-active', view.dataset.responseView === tab),
      );
    });
  });

  const createAuthInput = (
    id: string,
    label: string,
    type: string,
    placeholder: string,
    defaultValue = '',
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'auth-input-group';

    const labelEl = document.createElement('label');
    labelEl.htmlFor = id;
    labelEl.textContent = label;

    const inputEl = document.createElement('input');
    inputEl.type = type;
    inputEl.id = id;
    inputEl.placeholder = placeholder;
    inputEl.value = defaultValue;

    group.appendChild(labelEl);
    group.appendChild(inputEl);
    return group;
  };

  // Auth type change handler
  const renderAuthInputs = (authType: string) => {
    authInputsContainer.replaceChildren();

    switch (authType) {
      case 'bearer':
        authInputsContainer.appendChild(
          createAuthInput(
            'bearer-token',
            'Token',
            'password',
            'Enter your bearer token',
          ),
        );
        break;

      case 'api-key': {
        const grid = document.createElement('div');
        grid.className = 'auth-input-grid';
        grid.appendChild(
          createAuthInput(
            'api-key-header',
            'Header Name',
            'text',
            'e.g., X-API-Key',
            'X-API-Key',
          ),
        );
        grid.appendChild(
          createAuthInput(
            'api-key-value',
            'API Key',
            'password',
            'Enter your API key',
          ),
        );
        authInputsContainer.appendChild(grid);
        break;
      }

      case 'basic':
        authInputsContainer.appendChild(
          createAuthInput(
            'basic-username',
            'Username',
            'text',
            'Enter username',
          ),
        );
        authInputsContainer.appendChild(
          createAuthInput(
            'basic-password',
            'Password',
            'password',
            'Enter password',
          ),
        );
        break;

      case 'none':
      default:
        // No auth inputs needed
        break;
    }
  };

  authTypeSelect.addEventListener('change', () => {
    renderAuthInputs(authTypeSelect.value);
  });

  // Initialize with default auth type
  renderAuthInputs(authTypeSelect.value);

  const sessionDetailsToggle = document.getElementById(
    'session-details-toggle',
  ) as HTMLElement;
  const sessionDetailsContent = document.getElementById(
    'session-details-content',
  ) as HTMLElement;
  setupToggle(sessionDetailsToggle, sessionDetailsContent);
  if (layoutV2) {
    sessionDetailsContent?.classList.add('expanded');
    messageMetadataContent?.classList.add('expanded');
    const sessIcon = sessionDetailsToggle?.querySelector('.toggle-icon');
    if (sessIcon) sessIcon.textContent = '▼';
    const metaIcon = messageMetadataToggle?.querySelector('.toggle-icon');
    if (metaIcon) metaIcon.textContent = '▼';
  }

  addHeaderBtn.addEventListener('click', () => addHeaderField());
  addMetadataBtn.addEventListener('click', () => addMetadataField());

  function setupRemoveItemListener(
    listElement: HTMLElement,
    removeBtnSelector: string,
    itemSelector: string,
  ) {
    listElement.addEventListener('click', event => {
      const removeBtn = (event.target as HTMLElement).closest(
        removeBtnSelector,
      );
      if (removeBtn) {
        removeBtn.closest(itemSelector)?.remove();
      }
    });
  }

  setupRemoveItemListener(headersList, '.remove-header-btn', '.header-item');
  setupRemoveItemListener(
    metadataList,
    '.remove-metadata-btn',
    '.metadata-item',
  );

  // Phase 2: mount the topbar profile selector when layout-v2 is active.
  if (layoutV2 && idbAvailable()) {
    const topbarRoot = document.getElementById('topbar-root');
    if (topbarRoot) {
      mountTopbar(topbarRoot, {
        loadIntoForm: snapshot => {
          agentCardUrlInput.value = snapshot.agentCardUrl;
          headersList.innerHTML = '';
          for (const h of snapshot.customHeaders) {
            addHeaderField(h.name, h.value);
          }
        },
        readFromForm: () => ({
          agentCardUrl: agentCardUrlInput.value.trim(),
          customHeaders: Object.entries(
            getKeyValuePairs(
              headersList,
              '.header-item',
              '.header-name',
              '.header-value',
            ),
          ).map(([name, value]) => ({name, value})),
        }),
      })
        .then(t => {
          topbar = t;
          // Relocate live DOM elements into the topbar slots so existing
          // handlers stay attached.
          const urlInput = document.getElementById('agent-card-url');
          const connectBtnEl = document.getElementById('connect-btn');
          const themeWrap = document.querySelector(
            '.header-container .theme-toggle',
          );
          const httpHeaders = document.getElementById('http-headers-content');
          if (urlInput) t.slots.url.appendChild(urlInput);
          if (connectBtnEl) t.slots.connect.appendChild(connectBtnEl);
          if (themeWrap) t.slots.theme.appendChild(themeWrap);
          if (httpHeaders) t.slots.headersPanel.appendChild(httpHeaders);

          // Relocate the connection cluster (saved-profile select, Connect,
          // + New, Edit) from the topbar into the right-rail Connection
          // section. Live event handlers stay attached because we move the
          // same nodes.
          const connSlot = document.getElementById('rail-connection-slot');
          const connGroup = topbarRoot.querySelector('.topbar-conn-group');
          if (connSlot && connGroup) {
            connSlot.appendChild(connGroup);
          }

          const sidebarRoot = document.getElementById('sidebar-root');
          if (sidebarRoot) {
            sidebarRoot.removeAttribute('hidden');
            return mountSidebar(sidebarRoot, {
              getActiveProfileId: () => topbar?.getActiveProfileId() ?? null,
              loadDialog: (dialog: SavedDialog) => replayDialog(dialog),
              resetChat: () => {
                chatMessages.innerHTML =
                  '<p class="placeholder-text">Send a message to start inspecting.</p>';
                debugContent.innerHTML = '';
                responseLogs.innerHTML = '';
                responseTimeline.innerHTML = '';
                responsePretty.textContent = 'null';
                responseRaw.textContent = 'No response yet.';
                responseSummary.textContent =
                  'Send a message to inspect the result.';
                responseStatus.textContent = 'Idle';
                responseStatus.dataset.kind = 'idle';
                responseTime.textContent = '0 ms';
                responseSize.textContent = '0 B';
                Object.keys(rawLogStore).forEach(k => delete rawLogStore[k]);
                logIdQueue.length = 0;
                Object.keys(messageJsonStore).forEach(
                  k => delete messageJsonStore[k],
                );
                contextId = null;
                updateSessionUI();
              },
            }).then(s => {
              sidebar = s;
            });
          }
          return undefined;
        })
        .catch(err => console.warn('Topbar mount failed:', err));
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Extract base64 data (remove data:...; prefix)
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const createImageThumbnail = (file: File): Promise<string> => {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
  };

  const renderAttachmentPreview = (attachment: Attachment, index: number) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';

    // Add thumbnail for images
    if (attachment.mimeType.startsWith('image/') && attachment.thumbnail) {
      const thumbnail = document.createElement('img');
      thumbnail.className = 'attachment-thumbnail';
      thumbnail.src = attachment.thumbnail;
      chip.appendChild(thumbnail);
    }

    const info = document.createElement('div');
    info.className = 'attachment-info';

    const name = document.createElement('div');
    name.className = 'attachment-name';
    name.textContent = attachment.name;

    const size = document.createElement('div');
    size.className = 'attachment-size';
    size.textContent = formatFileSize(attachment.size);

    info.appendChild(name);
    info.appendChild(size);
    chip.appendChild(info);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove attachment';
    removeBtn.addEventListener('click', () => {
      attachments.splice(index, 1);
      updateAttachmentPreview();
    });
    chip.appendChild(removeBtn);

    return chip;
  };

  const updateAttachmentPreview = () => {
    attachmentsPreview.innerHTML = '';
    attachments.forEach((attachment, index) => {
      attachmentsPreview.appendChild(
        renderAttachmentPreview(attachment, index),
      );
    });
  };

  const handleFileSelection = async (files: FileList) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Check if file type is supported
      const isSupported = supportedInputModes.some(mode => {
        if (mode === '*/*') return true;
        if (mode.endsWith('/*')) {
          const prefix = mode.split('/')[0];
          return file.type.startsWith(prefix + '/');
        }
        return file.type === mode;
      });

      if (!isSupported) {
        alert(
          `File type ${file.type} is not supported by this agent. Supported types: ${supportedInputModes.join(', ')}`,
        );
        continue;
      }

      const base64Data = await fileToBase64(file);
      const attachment: Attachment = {
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        data: base64Data,
      };

      // Create thumbnail for images
      if (file.type.startsWith('image/')) {
        attachment.thumbnail = await createImageThumbnail(file);
      }

      attachments.push(attachment);
    }

    updateAttachmentPreview();
    fileInput.value = ''; // Reset file input
  };

  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      void handleFileSelection(fileInput.files);
    }
  });

  function addKeyValueField(
    list: HTMLElement,
    classes: {item: string; key: string; value: string; removeBtn: string},
    placeholders: {key: string; value: string},
    removeLabel: string,
    key = '',
    value = '',
  ) {
    const itemHTML = `
      <div class="${classes.item}">
        <input type="text" class="${classes.key}" placeholder="${placeholders.key}" value="${key}">
        <input type="text" class="${classes.value}" placeholder="${placeholders.value}" value="${value}">
        <button type="button" class="${classes.removeBtn}" aria-label="${removeLabel}">×</button>
      </div>
    `;
    list.insertAdjacentHTML('beforeend', itemHTML);
  }

  function addHeaderField(name = '', value = '') {
    addKeyValueField(
      headersList,
      {
        item: 'header-item',
        key: 'header-name',
        value: 'header-value',
        removeBtn: 'remove-header-btn',
      },
      {key: 'Header Name', value: 'Header Value'},
      'Remove header',
      name,
      value,
    );
  }

  function addMetadataField(key = '', value = '') {
    addKeyValueField(
      metadataList,
      {
        item: 'metadata-item',
        key: 'metadata-key',
        value: 'metadata-value',
        removeBtn: 'remove-metadata-btn',
      },
      {key: 'Metadata Key', value: 'Metadata Value'},
      'Remove metadata',
      key,
      value,
    );
  }

  function getKeyValuePairs(
    list: HTMLElement,
    itemSelector: string,
    keySelector: string,
    valueSelector: string,
  ): Record<string, string> {
    const items = list.querySelectorAll(itemSelector);
    return Array.from(items).reduce(
      (acc, item) => {
        const keyInput = item.querySelector(keySelector) as HTMLInputElement;
        const valueInput = item.querySelector(
          valueSelector,
        ) as HTMLInputElement;
        const key = keyInput?.value.trim();
        const value = valueInput?.value.trim();
        if (key && value) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  const getInputValue = (id: string): string => {
    const input = document.getElementById(id) as HTMLInputElement;
    return input?.value.trim() || '';
  };

  function getCustomHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const authType = authTypeSelect.value;

    // Add auth headers based on selected type
    switch (authType) {
      case 'bearer': {
        const token = getInputValue('bearer-token');
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        break;
      }

      case 'api-key': {
        const headerName = getInputValue('api-key-header');
        const value = getInputValue('api-key-value');
        if (headerName && value) {
          headers[headerName] = value;
        }
        break;
      }

      case 'basic': {
        const username = getInputValue('basic-username');
        const password = getInputValue('basic-password');
        if (username && password) {
          const credentials = btoa(`${username}:${password}`);
          headers['Authorization'] = `Basic ${credentials}`;
        }
        break;
      }

      case 'none':
      default:
        break;
    }

    // Always add custom headers from the header list
    const customHeaders = getKeyValuePairs(
      headersList,
      '.header-item',
      '.header-name',
      '.header-value',
    );
    Object.assign(headers, customHeaders);

    return headers;
  }

  function getMessageMetadata(): Record<string, string> {
    return getKeyValuePairs(
      metadataList,
      '.metadata-item',
      '.metadata-key',
      '.metadata-value',
    );
  }

  clearConsoleBtn.addEventListener('click', () => {
    debugContent.innerHTML = '';
    Object.keys(rawLogStore).forEach(key => delete rawLogStore[key]);
    logIdQueue.length = 0;
  });

  toggleConsoleBtn.addEventListener('click', () => {
    const isHidden = debugConsole.classList.toggle('hidden');
    toggleConsoleBtn.textContent = isHidden ? 'Show' : 'Hide';
  });

  newSessionBtn.addEventListener('click', () => {
    resetSession();
  });

  function buildDialogText(): string {
    const lines: string[] = [];
    const messages = chatMessages.querySelectorAll<HTMLElement>('.message');
    for (const el of Array.from(messages)) {
      if (el.classList.contains('agent-loading')) continue;
      const cls = el.className.replace(/^message\s*/, '').split(/\s+/);
      const role = cls[0] || 'message';
      const contentEl = el.querySelector('.message-content') as HTMLElement | null;
      const text = (contentEl?.innerText ?? el.innerText ?? '').trim();
      if (!text) continue;
      lines.push(`[${role}] ${text}`);
    }
    return lines.join('\n\n');
  }

  async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to legacy path */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  if (copyDialogBtn) {
    copyDialogBtn.addEventListener('click', async () => {
      const text = buildDialogText();
      if (!text) {
        const original = copyDialogBtn.textContent ?? 'Copy';
        copyDialogBtn.textContent = 'Empty';
        window.setTimeout(() => {
          copyDialogBtn.textContent = original;
        }, 1200);
        return;
      }
      const ok = await copyTextToClipboard(text);
      const original = 'Copy';
      copyDialogBtn.textContent = ok ? 'Copied' : 'Failed';
      copyDialogBtn.classList.toggle('is-copied', ok);
      window.setTimeout(() => {
        copyDialogBtn.textContent = original;
        copyDialogBtn.classList.remove('is-copied');
      }, 1200);
    });
  }

  modalCloseBtn.addEventListener('click', () =>
    jsonModal.classList.add('hidden'),
  );
  jsonModal.addEventListener('click', (e: MouseEvent) => {
    if (e.target === jsonModal) {
      jsonModal.classList.add('hidden');
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const showJsonInModal = (jsonData: any) => {
    if (jsonData) {
      let jsonString = JSON.stringify(jsonData, null, 2);
      jsonString = jsonString.replace(
        /"method": "([^"]+)"/g,
        '<span class="json-highlight">"method": "$1"</span>',
      );
      modalJsonContent.innerHTML = jsonString;
      jsonModal.classList.remove('hidden');
    }
  };

  function detectBearerToken(headers: Record<string, string>): string | null {
    const entry = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === 'authorization',
    );
    if (!entry) return null;
    const match = /^Bearer\s+(.+)$/i.exec(entry[1]);
    return match ? match[1].trim() : null;
  }

  function applyNewBearerToken(newToken: string): void {
    if (authTypeSelect.value === 'bearer') {
      let input = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement | null;
      if (!input) {
        renderAuthInputs('bearer');
        input = document.getElementById(
          'bearer-token',
        ) as HTMLInputElement | null;
      }
      if (input) input.value = newToken;
      return;
    }
    const items = headersList.querySelectorAll('.header-item');
    for (const item of Array.from(items)) {
      const nameEl = item.querySelector('.header-name') as HTMLInputElement | null;
      const valueEl = item.querySelector(
        '.header-value',
      ) as HTMLInputElement | null;
      if (nameEl && nameEl.value.toLowerCase() === 'authorization' && valueEl) {
        valueEl.value = `Bearer ${newToken}`;
        return;
      }
    }
    authTypeSelect.value = 'bearer';
    renderAuthInputs('bearer');
    const created = document.getElementById(
      'bearer-token',
    ) as HTMLInputElement | null;
    if (created) created.value = newToken;
  }

  let pendingBearerToken: string | null = null;
  let reauthInFlight = false;

  async function maybePromptReauth(
    status: number | string,
    message: string | undefined,
    bearerToken: string | null,
  ): Promise<boolean> {
    if (reauthInFlight) return false;
    if (!bearerToken) return false;
    const code = typeof status === 'number' ? status : Number(status);
    if (code !== 401 && code !== 403) return false;
    reauthInFlight = true;
    try {
      const profileId = topbar?.getActiveProfileId() ?? null;
      let connectionName: string | undefined;
      if (profileId) {
        try {
          const p = await getProfile(profileId);
          connectionName = p?.name;
        } catch {
          /* ignore */
        }
      }
      const result = await showReauthDialog({
        status: code,
        connectionName,
        currentToken: bearerToken,
        errorMessage: message,
      });
      if (!result) return false;
      applyNewBearerToken(result.token);
      window.setTimeout(() => runConnect(), 0);
      return true;
    } finally {
      reauthInFlight = false;
    }
  }

  async function runConnect(): Promise<void> {
    let agentCardUrl = agentCardUrlInput.value.trim();
    if (!agentCardUrl) {
      alert('Please enter an agent card URL.');
      return;
    }

    // If no protocol is specified, prepend http://
    if (!/^[a-zA-Z]+:\/\//.test(agentCardUrl)) {
      agentCardUrl = 'http://' + agentCardUrl;
    }

    // Validate that the URL uses http or https protocol
    try {
      const url = new URL(agentCardUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Protocol must be http or https.');
      }
    } catch (error) {
      alert(
        'Invalid URL. Please enter a valid URL starting with http:// or https://.',
      );
      return;
    }

    agentCardCodeContent.textContent = '';
    validationErrorsContainer.innerHTML =
      '<div class="loader"></div><p class="placeholder-text">Fetching Agent Card...</p>';
    chatInput.disabled = true;
    sendBtn.disabled = true;
    lastRequestStartedAt = performance.now();
    topbar?.setConnectionStatus('idle', 'Connecting');
    responseLogs.innerHTML = '';
    responseTimeline.innerHTML = '';
    responseStatus.textContent = 'Fetching';
    responseStatus.dataset.kind = 'idle';
    responseTime.textContent = '0 ms';
    responseSize.textContent = '0 B';
    responseSummary.textContent = 'Fetching agent card.';
    responsePretty.textContent = JSON.stringify(
      {url: agentCardUrl, phase: 'agent-card'},
      null,
      2,
    );
    responseRaw.textContent = responsePretty.textContent;
    appendTimeline('Agent card request', agentCardUrl);

    const customHeaders = getCustomHeaders();
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };
    const bearerInUse = detectBearerToken(customHeaders);
    pendingBearerToken = bearerInUse;

    try {
      const response = await fetch('/agent-card', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({url: agentCardUrl, sid: socket.id}),
      });
      const data = await response.json();
      if (!response.ok) {
        if (
          (response.status === 401 || response.status === 403) &&
          bearerInUse
        ) {
          const handled = await maybePromptReauth(
            response.status,
            data?.error,
            bearerInUse,
          );
          if (handled) return;
        }
        throw new Error(data.error || `HTTP error! status: ${response.status}`);
      }
      setResponsePayload(
        {
          agentCard: data.card,
          validation_errors: data.validation_errors,
        },
        String(response.status),
        'Agent card fetched. Initializing client session.',
      );

      agentCardCodeContent.textContent = JSON.stringify(data.card, null, 2);
      if (window.hljs) {
        window.hljs.highlightElement(agentCardCodeContent);
      } else {
        console.warn('highlight.js not loaded. Syntax highlighting skipped.');
      }

      validationErrorsContainer.innerHTML =
            '<p class="placeholder-text">Initializing client session...</p>';

      initializationTimeout = setTimeout(() => {
        validationErrorsContainer.innerHTML =
          '<p class="error-text">Error: Client initialization timed out.</p>';
        chatInput.disabled = true;
        sendBtn.disabled = true;
      }, INITIALIZATION_TIMEOUT_MS);

      socket.emit('initialize_client', {
        url: agentCardUrl,
        customHeaders: customHeaders,
      });

      // Persist profile state on successful connect.
      if (idbAvailable()) {
        const activeId = topbar?.getActiveProfileId() ?? null;
        const headerArr = Object.entries(customHeaders).map(
          ([name, value]) => ({name, value}),
        );
        const persistPromise = activeId
          ? getProfile(activeId).then(p =>
              p
                ? upsertProfile({
                    ...p,
                    agentCardUrl,
                    customHeaders: headerArr,
                    lastConnectedAt: new Date().toISOString(),
                  })
                : upsertImplicit(agentCardUrl, customHeaders),
            )
          : upsertImplicit(agentCardUrl, customHeaders);
        persistPromise
          .then(profile => {
            setLastProfileId(profile.id);
            topbar?.refresh();
          })
          .catch(err => console.warn('Profile persist failed:', err));
      }

      if (data.validation_errors.length > 0) {
        validationErrorsContainer.innerHTML = `<h3>Validation Errors</h3><ul>${data.validation_errors.map((e: string) => `<li>${e}</li>`).join('')}</ul>`;
      } else {
        validationErrorsContainer.innerHTML =
          '<p class="success-text">Agent card is valid.</p>';
      }
    } catch (error) {
      clearTimeout(initializationTimeout);
      validationErrorsContainer.innerHTML = `<p class="error-text">Error: ${(error as Error).message}</p>`;
      topbar?.setConnectionStatus('error', 'Connection error');
      document.body.classList.remove('is-connected');
      setResponsePayload(
        {
          error: (error as Error).message,
          url: agentCardUrl,
          phase: 'agent-card',
        },
        'error',
        'Connection failed while fetching the agent card.',
      );
      chatInput.disabled = true;
      sendBtn.disabled = true;
    }
  }

  connectBtn.addEventListener('click', () => {
    runConnect().catch(err => console.warn('Connect failed:', err));
  });

  socket.on(
    'client_initialized',
    (data: {
      status: string;
      message?: string;
      httpStatus?: number;
      transport?: string;
      inputModes?: string[];
      outputModes?: string[];
    }) => {
      clearTimeout(initializationTimeout);
      if (data.status === 'success') {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatMessages.innerHTML =
          '<p class="placeholder-text">Send a message to start inspecting.</p>';
        debugContent.innerHTML = '';
        Object.keys(rawLogStore).forEach(key => delete rawLogStore[key]);
        logIdQueue.length = 0;
        Object.keys(messageJsonStore).forEach(
          key => delete messageJsonStore[key],
        );

        // Set connection state and reset session when connecting to a new agent
        isConnected = true;
        topbar?.setConnectionStatus(
          'connected',
          data.transport ? `Connected · ${data.transport}` : 'Connected',
        );
        topbar?.closeConnectionPopup();
        document.body.classList.add('is-connected');
        resetSession();

        // Phase 3: ensure an active dialog exists for the active profile.
        if (sidebar && !sidebar.getActiveDialogId()) {
          sidebar
            .createDialogForActiveProfile()
            .catch(err => console.warn('auto-create dialog failed:', err));
        }

        // Store supported modalities
        supportedInputModes = data.inputModes || ['text/plain'];
        supportedOutputModes = data.outputModes || ['text/plain'];

        // Update transport in Session Details
        const sessionTransport = document.getElementById(
          'session-transport',
        ) as HTMLElement;
        if (data.transport && sessionTransport) {
          sessionTransport.textContent = data.transport;
        } else if (sessionTransport) {
          sessionTransport.textContent = 'Unknown';
        }

        // Update modalities display in Session Details
        updateModalitiesDisplay();

        // Enable attach button
        attachBtn.disabled = false;
      } else {
        validationErrorsContainer.innerHTML = `<p class="error-text">Error initializing client: ${data.message}</p>`;
        isConnected = false;
        topbar?.setConnectionStatus('error', 'Connection error');
        setResponsePayload(
          {
            error: data.message ?? 'Client initialization failed.',
            httpStatus: data.httpStatus,
            phase: 'client-initialization',
          },
          'error',
          'Connection failed during client initialization.',
        );
        document.body.classList.remove('is-connected');
        updateSessionUI();
        if (
          (data.httpStatus === 401 || data.httpStatus === 403) &&
          pendingBearerToken
        ) {
          maybePromptReauth(
            data.httpStatus,
            data.message,
            pendingBearerToken,
          ).catch(err => console.warn('Reauth prompt failed:', err));
        }
      }
    },
  );

  const getModalityIcon = (mimeType: string): string => {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('text/')) return '📝';
    if (mimeType.includes('pdf')) return '📄';
    return '📎';
  };

  const updateModalitiesDisplay = () => {
    const inputModesEl = document.getElementById('session-input-modes');
    const outputModesEl = document.getElementById('session-output-modes');

    if (inputModesEl) {
      const inputHTML = supportedInputModes
        .map(
          mode =>
            `<span class="modality-tag">${getModalityIcon(mode)} ${mode}</span>`,
        )
        .join('');
      inputModesEl.innerHTML =
        inputHTML || '<span class="modality-none">None specified</span>';
    }

    if (outputModesEl) {
      const outputHTML = supportedOutputModes
        .map(
          mode =>
            `<span class="modality-tag">${getModalityIcon(mode)} ${mode}</span>`,
        )
        .join('');
      outputModesEl.innerHTML =
        outputHTML || '<span class="modality-none">None specified</span>';
    }
  };

  const updateSessionUI = () => {
    const sessionDetails = document.getElementById(
      'session-details',
    ) as HTMLElement;
    const newSessionBtn = document.getElementById(
      'new-session-btn',
    ) as HTMLButtonElement;

    if (!isConnected) {
      if (sessionDetails) {
        sessionDetails.textContent = 'No active session';
      }
      if (newSessionBtn) {
        newSessionBtn.disabled = true;
      }
    } else if (contextId) {
      if (sessionDetails) {
        sessionDetails.textContent = contextId;
      }
      if (newSessionBtn) {
        newSessionBtn.disabled = false;
      }
    } else {
      if (sessionDetails) {
        sessionDetails.textContent = 'No active session';
      }
      if (newSessionBtn) {
        newSessionBtn.disabled = true;
      }

      const placeholder = chatMessages.querySelector('.placeholder-text');
      if (placeholder) {
        placeholder.textContent = 'Send a message to start inspecting.';
      }
    }
  };

  const resetSession = () => {
    contextId = null;
    chatMessages.innerHTML =
      '<p class="placeholder-text">Send a message to start inspecting.</p>';
    updateSessionUI();
  };

  const showLoadingIndicator = () => {
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message agent-loading';
    loadingDiv.id = 'loading-indicator';
    loadingDiv.innerHTML = `
      <div class="loading-spinner"></div>
      <span class="loading-text">Agent is thinking...</span>
    `;
    chatMessages.appendChild(loadingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };

  const hideLoadingIndicator = () => {
    const loadingIndicator = document.getElementById('loading-indicator');
    if (loadingIndicator) {
      loadingIndicator.remove();
    }
  };

  const sendMessage = () => {
    let draft = buildRequestDraft(chatInput.value);
    if (requestBodyJson?.value.trim()) {
      try {
        const parsed = JSON.parse(requestBodyJson.value) as {
          message?: unknown;
          context?: unknown;
          tools?: unknown;
        };
        draft = {
          message:
            typeof parsed.message === 'string'
              ? parsed.message
              : chatInput.value,
          context:
            parsed.context &&
            typeof parsed.context === 'object' &&
            !Array.isArray(parsed.context)
              ? (parsed.context as Record<string, unknown>)
              : draft.context,
          tools: Array.isArray(parsed.tools)
            ? parsed.tools.filter((tool): tool is string => typeof tool === 'string')
            : draft.tools,
        };
      } catch {
        responseStatus.textContent = 'Invalid JSON';
        responseStatus.dataset.kind = 'error';
        responseSummary.textContent = 'Fix the raw request body before sending.';
        return;
      }
    }
    const messageText = draft.message;
    if ((messageText.trim() || attachments.length > 0) && !chatInput.disabled) {
      const sanitizedMessage = DOMPurify.sanitize(messageText);

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      const metadata = {
        ...getMessageMetadata(),
        ...(draft.tools.length > 0 ? {tools: draft.tools} : {}),
      };
      const attachmentsForDisplay = [...attachments];

      appendMessage(
        'user',
        sanitizedMessage,
        messageId,
        false,
        [],
        attachmentsForDisplay,
      );
      showLoadingIndicator();

      const attachmentsToSend = attachments.map(a => ({
        data: a.data,
        mimeType: a.mimeType,
      }));

      lastRequestStartedAt = performance.now();
      lastRequestId = messageId;
      responseStatus.textContent = 'Sending';
      responseStatus.dataset.kind = 'idle';
      responseTime.textContent = '0 ms';
      responseSize.textContent = '0 B';
      responseSummary.textContent = 'Request in flight.';
      responseTimeline.innerHTML = '';
      appendTimeline('Request', sanitizedMessage || 'attachment payload');

      socket.emit('send_message', {
        message: sanitizedMessage,
        id: messageId,
        contextId,
        metadata,
        attachments: attachmentsToSend,
      });

      chatInput.value = '';
      attachments.length = 0;
      updateAttachmentPreview();
      syncRequestBodyJson();
    }
  };

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keypress', (e: KeyboardEvent) => {
    if (e.key === 'Enter') sendMessage();
  });
  chatInput.addEventListener('input', syncRequestBodyJson);
  document
    .querySelectorAll<HTMLInputElement>('.tool-checkbox')
    .forEach(input => input.addEventListener('change', syncRequestBodyJson));

  const renderMultimediaContent = (uri: string, mimeType: string): string => {
    const sanitizedUri = DOMPurify.sanitize(uri);
    const sanitizedMimeType = DOMPurify.sanitize(mimeType);

    if (mimeType.startsWith('image/')) {
      return `<div class="media-container"><img src="${sanitizedUri}" alt="Image attachment" class="media-image" /></div>`;
    } else if (mimeType.startsWith('audio/')) {
      return `<div class="media-container"><audio controls class="media-audio"><source src="${sanitizedUri}" type="${sanitizedMimeType}">Your browser does not support audio playback.</audio></div>`;
    } else if (mimeType.startsWith('video/')) {
      return `<div class="media-container"><video controls class="media-video"><source src="${sanitizedUri}" type="${sanitizedMimeType}">Your browser does not support video playback.</video></div>`;
    } else if (mimeType === 'application/pdf') {
      return `<div class="media-container"><a href="${sanitizedUri}" target="_blank" rel="noopener noreferrer" class="file-link">📄 View PDF</a></div>`;
    } else {
      // For other file types, show a download link
      const icon = getModalityIcon(mimeType);
      return `<div class="media-container"><a href="${sanitizedUri}" target="_blank" rel="noopener noreferrer" class="file-link">${icon} Download file (${sanitizedMimeType})</a></div>`;
    }
  };

  const renderBase64Data = (base64Data: string, mimeType: string): string => {
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    return renderMultimediaContent(dataUri, mimeType);
  };

  const camelToLabel = (name: string): string =>
    name
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^./, s => s.toUpperCase())
      .trim();

  const renderUiToolCall = (tool: UiToolCallPayload): string => {
    const rawName = typeof tool.name === 'string' ? tool.name : '';
    const safeName = DOMPurify.sanitize(rawName);

    if (rawName === 'navigation') {
      const url =
        tool.args && typeof tool.args.url === 'string' ? tool.args.url : '';
      const safeUrl = DOMPurify.sanitize(url);
      const ariaLabel = DOMPurify.sanitize(`Navigation: ${url}`);
      const linkHtml = url
        ? `<a class="part-tool-call__value" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`
        : `<span class="part-tool-call__value">(no URL)</span>`;
      return (
        `<div class="part-tool-call part-tool-call--navigation" role="status" aria-label="${ariaLabel}" tabindex="0">` +
        `<span class="part-tool-call__icon" aria-hidden="true">→</span>` +
        `<span class="part-tool-call__body">` +
        `<span class="part-tool-call__label">Navigate to</span>` +
        linkHtml +
        `</span>` +
        `</div>`
      );
    }

    const humanName = rawName ? camelToLabel(rawName) : 'Unknown tool';
    const safeHuman = DOMPurify.sanitize(humanName);
    const ariaLabel = DOMPurify.sanitize(`Awaiting input: ${humanName}`);
    return (
      `<div class="part-tool-call part-tool-call--selector" role="status" aria-label="${ariaLabel}" title="${safeName}" tabindex="0">` +
      `<span class="part-tool-call__icon" aria-hidden="true">⏳</span>` +
      `<span class="part-tool-call__body">` +
      `<span class="part-tool-call__label">Awaiting input</span>` +
      `<span class="part-tool-call__value">${safeHuman}</span>` +
      `</span>` +
      `</div>`
    );
  };

  const processPart = (p: any): string | null => {
    if (p.text) {
      return DOMPurify.sanitize(marked.parse(p.text) as string);
    } else if (p.file) {
      const {uri, bytes, mimeType} = p.file;
      if (bytes && mimeType) {
        return renderBase64Data(bytes, mimeType);
      } else if (uri && mimeType) {
        return renderMultimediaContent(uri, mimeType);
      }
    } else if (p.data) {
      const dataObj = p.data as {
        type?: string;
        data?: UiToolCallPayload;
        mimeType?: string;
      } & Record<string, unknown>;
      if (
        dataObj.type === 'ui_tool_call' &&
        dataObj.data &&
        typeof dataObj.data === 'object'
      ) {
        return renderUiToolCall(dataObj.data);
      }
      if (dataObj.mimeType && typeof dataObj.data === 'string') {
        return renderBase64Data(dataObj.data as string, dataObj.mimeType);
      } else {
        return `<pre><code>${DOMPurify.sanitize(JSON.stringify(p.data, null, 2))}</code></pre>`;
      }
    }
    return null;
  };

  const collectPartsContent = (parts?: any[]): string[] => {
    if (!parts) return [];
    return parts.flatMap(part => {
      const content = processPart(part);
      return content ? [content] : [];
    });
  };

  const buildDetails = (
    kind: string,
    validationErrors: string[],
    status?: string,
  ): MessageDetails => ({
    kind,
    status,
    validation: validationErrors.length > 0 ? 'invalid' : 'valid',
    validationErrors,
  });

  const stripInlineDetailsFromAgentAnswer = (
    html: string,
    details?: MessageDetails,
  ): {html: string; details?: MessageDetails} => {
    const template = document.createElement('template');
    template.innerHTML = html;
    let nextDetails = details ? {...details} : undefined;

    template.content.querySelectorAll('.kind-chip').forEach(chip => {
      const value = chip.textContent?.trim();
      if (value) {
        if (!nextDetails?.kind && value === 'message') {
          (nextDetails ??= {validation: 'valid'}).kind = value;
        } else if (!nextDetails?.status && value === 'completed') {
          (nextDetails ??= {validation: 'valid'}).status = value;
        }
      }
      chip.remove();
    });

    return {
      html: template.innerHTML.trim(),
      details: nextDetails,
    };
  };

  socket.on('agent_response', (event: AgentResponseEvent) => {
    // Hide loading indicator on first response
    hideLoadingIndicator();
    setResponsePayload(
      event,
      event.error ? 'error' : 'event',
      event.error ? 'Agent returned an error.' : `Received ${event.kind}.`,
    );

    const displayMessageId = `display-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    messageJsonStore[displayMessageId] = event;

    const validationErrors = event.validation_errors || [];

    if (event.error) {
      const messageHtml = `<span class="kind-chip kind-chip-error">error</span> Error: ${DOMPurify.sanitize(event.error)}`;
      appendMessage(
        'agent error',
        messageHtml,
        displayMessageId,
        true,
        validationErrors,
        [],
        buildDetails('error', validationErrors),
      );
      return;
    }

    if (event.contextId) {
      contextId = event.contextId;
      updateSessionUI();
      // Phase 3: persist contextId to active dialog so replay can resume it.
      if (!isReplaying && sidebar?.getActiveDialogId()) {
        sidebar
          .updateActiveDialog({contextId: event.contextId})
          .catch(err => console.warn('persist contextId failed:', err));
      }
    }

    switch (event.kind) {
      case 'task': {
        // Non-streaming A2A responses often carry the final answer in the
        // task status message rather than as a top-level message event.
        const statusContent = collectPartsContent(event.status?.message?.parts);
        const hasArtifacts = event.artifacts && event.artifacts.length > 0;

        if (statusContent.length > 0) {
          const inputRequiredChip =
            event.status?.state === 'input-required'
              ? '<span class="kind-chip kind-chip-input-required">input required</span> '
              : '';
          appendMessage(
            'agent',
            inputRequiredChip + statusContent.join(''),
            displayMessageId,
            true,
            validationErrors,
            [],
            buildDetails(event.kind, validationErrors, event.status?.state),
          );
        } else if (hasArtifacts && event.artifacts) {
          // For HTTP+JSON tasks with artifacts, display content with kind chip (like JSON-RPC messages)
          // Collect all artifact content
          const allContent: string[] = [];

          event.artifacts.forEach(artifact => {
            artifact.parts?.forEach(p => {
              const content = processPart(p);
              if (content) allContent.push(content);
            });
          });

          // Display with kind chip for consistency with JSON-RPC messages
          if (allContent.length > 0) {
            const combinedContent = allContent.join('');
            const kindChip = `<span class="kind-chip kind-chip-${event.kind}">${event.kind}</span>`;
            const messageHtml = `${kindChip} ${combinedContent}`;
            appendMessage(
              'agent',
              messageHtml,
              displayMessageId,
              true,
              validationErrors,
              [],
              buildDetails(event.kind, validationErrors, event.status?.state),
            );
          }
        } else if (event.status) {
          // Only show task status if there are no artifacts
          const statusHtml = `<span class="kind-chip kind-chip-task">${event.kind}</span> Task created with status: ${DOMPurify.sanitize(event.status.state)}`;
          appendMessage(
            'agent progress',
            statusHtml,
            displayMessageId,
            true,
            validationErrors,
            [],
            buildDetails(event.kind, validationErrors, event.status.state),
          );
        }
        break;
      }
      case 'status-update': {
        const statusContent = collectPartsContent(
          event.status?.message?.parts,
        );
        if (statusContent.length > 0) {
          const inputRequiredChip =
            event.status?.state === 'input-required'
              ? ' <span class="kind-chip kind-chip-input-required">input required</span>'
              : '';
          const messageHtml = `<span class="kind-chip kind-chip-status-update">${event.kind}</span>${inputRequiredChip} ${statusContent.join('')}`;
          appendMessage(
            'agent progress',
            messageHtml,
            displayMessageId,
            true,
            validationErrors,
            [],
            buildDetails(event.kind, validationErrors, event.status?.state),
          );
        }
        break;
      }
      case 'artifact-update':
        event.artifact?.parts?.forEach(p => {
          const content = processPart(p);
          if (content) {
            const kindChip = `<span class="kind-chip kind-chip-artifact-update">${event.kind}</span>`;
            const messageHtml = `${kindChip} ${content}`;
            appendMessage(
              'agent',
              messageHtml,
              displayMessageId,
              true,
              validationErrors,
              [],
              buildDetails(event.kind, validationErrors),
            );
          }
        });
        break;
      case 'message': {
        const messageContent = collectPartsContent(event.parts);
        if (messageContent.length > 0) {
          appendMessage(
            'agent',
            messageContent.join(''),
            displayMessageId,
            true,
            validationErrors,
            [],
            buildDetails(event.kind, validationErrors),
          );
        }
        break;
      }
    }
  });

  function processLogQueue() {
    if (isProcessingLogQueue) return;
    isProcessingLogQueue = true;

    while (logIdQueue.length > MAX_LOGS) {
      const oldestKey = logIdQueue.shift();
      if (
        oldestKey &&
        Object.prototype.hasOwnProperty.call(rawLogStore, oldestKey)
      ) {
        delete rawLogStore[oldestKey];
      }
    }
    isProcessingLogQueue = false;
  }

  socket.on('debug_log', (log: DebugLog) => {
    renderDebugLog(log);
    renderResponseLog(log);
    persistDebugEvent(log);
  });

  function appendMessage(
    sender: string,
    content: string,
    messageId: string,
    isHtml = false,
    validationErrors: string[] = [],
    attachmentsToShow: Attachment[] = [],
    details?: MessageDetails,
  ) {
    const placeholder = chatMessages.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const messageElement = document.createElement('div');
    messageElement.className = `message ${sender.replace(' ', '-')}`;

    // Add attachments section if there are attachments
    if (attachmentsToShow.length > 0) {
      const attachmentsSection = document.createElement('div');
      attachmentsSection.className = 'message-attachments';

      attachmentsToShow.forEach(attachment => {
        const badge = document.createElement('div');
        badge.className = 'attachment-badge';

        const icon = getModalityIcon(attachment.mimeType);
        badge.innerHTML = `${icon} ${DOMPurify.sanitize(attachment.name)}`;

        attachmentsSection.appendChild(badge);
      });

      messageElement.appendChild(attachmentsSection);
    }

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';
    let renderedContent = content;
    let effectiveDetails = details;

    if (sender === 'agent' && isHtml) {
      const stripped = stripInlineDetailsFromAgentAnswer(
        renderedContent,
        effectiveDetails,
      );
      renderedContent = stripped.html;
      effectiveDetails = stripped.details;
    }

    if (isHtml) {
      messageContent.innerHTML = renderedContent;
    } else {
      messageContent.textContent = renderedContent;
    }

    if (renderedContent.trim()) {
      messageElement.appendChild(messageContent);
    }

    const statusIndicator = document.createElement('span');
    statusIndicator.className = 'validation-status';
    if (sender !== 'user') {
      if (validationErrors.length > 0) {
        statusIndicator.classList.add('invalid');
        statusIndicator.textContent = '⚠️';
        statusIndicator.title = validationErrors.join('\n');
      } else {
        statusIndicator.classList.add('valid');
        statusIndicator.textContent = '✅';
        statusIndicator.title = 'Message is compliant';
      }
      messageElement.appendChild(statusIndicator);
    }

    if (sender !== 'user') {
      const messageDetails: MessageDetails = effectiveDetails ?? {
        validation: validationErrors.length > 0 ? 'invalid' : 'valid',
        validationErrors,
      };
      const detailsWrap = document.createElement('div');
      detailsWrap.className = 'message-details';

      const detailsBtn = document.createElement('button');
      detailsBtn.type = 'button';
      detailsBtn.className = 'message-details-btn';
      detailsBtn.setAttribute('aria-label', 'Message details');
      detailsBtn.title = 'Message details';
      detailsBtn.textContent = 'i';

      const detailsMenu = document.createElement('div');
      detailsMenu.className = 'message-details-menu';
      detailsMenu.setAttribute('role', 'menu');

      const rows: Array<[string, string]> = [];
      if (messageDetails.kind) rows.push(['Kind', messageDetails.kind]);
      if (messageDetails.status) rows.push(['Status', messageDetails.status]);
      if (messageDetails.transport) {
        rows.push(['Transport', messageDetails.transport]);
      }
      rows.push([
        'Validation',
        messageDetails.validation === 'valid' ? 'Compliant' : 'Needs review',
      ]);
      if (messageDetails.validationErrors?.length) {
        rows.push(['Issues', messageDetails.validationErrors.join('\n')]);
      }

      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'message-details-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'message-details-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'message-details-value';
        valueEl.textContent = value;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        detailsMenu.appendChild(row);
      }

      detailsWrap.addEventListener('click', e => {
        e.stopPropagation();
      });
      detailsWrap.appendChild(detailsBtn);
      detailsWrap.appendChild(detailsMenu);
      messageElement.appendChild(detailsWrap);
    }

    messageElement.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'A' && !target.closest('.message-details')) {
        const jsonData =
          sender === 'user'
            ? rawLogStore[messageId]?.request
            : messageJsonStore[messageId];
        showJsonInModal(jsonData);
      }
    });

    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Phase 3: persist to active dialog (skip during replay).
    if (!isReplaying && sidebar && idbAvailable()) {
      const dialogId = sidebar.getActiveDialogId();
      if (dialogId) {
        const persisted: ChatMessage = {
          id: messageId,
          role: sender.startsWith('agent') ? 'agent' : 'user',
          kind: sender,
          html: isHtml ? renderedContent : undefined,
          text: isHtml ? undefined : renderedContent,
          validationErrors,
          attachments: attachmentsToShow,
          metadata: effectiveDetails as Record<string, unknown> | undefined,
          createdAt: new Date().toISOString(),
        };
        dbAppendMessage(dialogId, persisted)
          .then(() => sidebar?.refresh())
          .catch(err => console.warn('persist message failed:', err));
      }
    }
  }

  function persistDebugEvent(log: DebugLog) {
    if (isReplaying || !sidebar || !idbAvailable()) return;
    const dialogId = sidebar.getActiveDialogId();
    if (!dialogId) return;
    const event: DebugEvent = {
      id: log.id,
      direction: log.type as DebugEvent['direction'],
      payload: log.data,
      createdAt: new Date().toISOString(),
    };
    dbAppendDebug(dialogId, event).catch(err =>
      console.warn('persist debug failed:', err),
    );
  }

  function renderDebugLog(log: DebugLog) {
    const logEntry = document.createElement('div');
    const timestamp = new Date().toLocaleTimeString();
    let jsonString = JSON.stringify(log.data, null, 2);
    jsonString = jsonString.replace(
      /"method": "([^"]+)"/g,
      '<span class="json-highlight">"method": "$1"</span>',
    );
    logEntry.className = `log-entry log-${log.type}`;
    logEntry.innerHTML = `
            <div>
                <span class="log-timestamp">${timestamp}</span>
                <strong>${log.type.toUpperCase()}</strong>
            </div>
            <pre>${jsonString}</pre>
        `;
    debugContent.appendChild(logEntry);
    if (!rawLogStore[log.id]) {
      rawLogStore[log.id] = {};
    }
    rawLogStore[log.id][log.type] = log.data;
    logIdQueue.push(log.id);
    setTimeout(processLogQueue, 0);
    debugContent.scrollTop = debugContent.scrollHeight;
  }

  function replayDialog(dialog: SavedDialog) {
    isReplaying = true;
    try {
      chatMessages.innerHTML = '';
      Object.keys(messageJsonStore).forEach(k => delete messageJsonStore[k]);
      for (const m of dialog.messages) {
        const isHtml = m.html !== undefined;
        const content = m.html ?? m.text ?? '';
        const sender = m.kind ?? (m.role === 'user' ? 'user' : 'agent');
        appendMessage(
          sender,
          content,
          m.id,
          isHtml,
          m.validationErrors ?? [],
          (m.attachments ?? []) as Attachment[],
          m.metadata as MessageDetails | undefined,
        );
      }
      debugContent.innerHTML = '';
      responseLogs.innerHTML = '';
      responseTimeline.innerHTML = '';
      Object.keys(rawLogStore).forEach(k => delete rawLogStore[k]);
      logIdQueue.length = 0;
      for (const e of dialog.debugEvents) {
        const log = {
          id: e.id,
          type: e.direction as DebugLog['type'],
          data: e.payload,
        };
        renderDebugLog(log);
        renderResponseLog(log);
      }
      if (dialog.debugEvents.length > 0) {
        const last = dialog.debugEvents[dialog.debugEvents.length - 1];
        setResponsePayload(last.payload, last.direction, 'Replayed saved log.');
      }
      contextId = dialog.contextId ?? null;
      updateSessionUI();
    } finally {
      isReplaying = false;
    }
  }
});
