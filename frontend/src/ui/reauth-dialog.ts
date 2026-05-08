export interface ReauthRequest {
  /** HTTP status that triggered the prompt (typically 401 or 403). */
  status: number | string;
  /** Profile or connection name to display. */
  connectionName?: string;
  /** Current bearer token (sans "Bearer " prefix), if known. */
  currentToken?: string;
  /** Optional error message from the server. */
  errorMessage?: string;
}

export interface ReauthResult {
  /** New token, without the "Bearer " prefix. */
  token: string;
}

let mounted = false;

function ensureMounted(): HTMLDivElement {
  let root = document.getElementById('reauth-modal') as HTMLDivElement | null;
  if (root) return root;
  root = document.createElement('div');
  root.id = 'reauth-modal';
  root.className = 'reauth-modal';
  root.setAttribute('hidden', '');
  root.innerHTML = `
    <div class="reauth-modal-panel" role="dialog" aria-modal="true" aria-labelledby="reauth-modal-title">
      <div class="reauth-modal-header">
        <h2 id="reauth-modal-title">Authentication failed</h2>
        <button type="button" class="topbar-icon-btn" id="reauth-close" aria-label="Close">×</button>
      </div>
      <div class="reauth-modal-body">
        <p id="reauth-modal-message" class="reauth-modal-message"></p>
        <label class="connection-field">
          <span>Bearer token</span>
          <input id="reauth-token-input" class="topbar-input" type="password" autocomplete="off" placeholder="Paste a fresh bearer token" />
        </label>
        <label class="reauth-show-token">
          <input type="checkbox" id="reauth-show-token" />
          <span>Show token</span>
        </label>
      </div>
      <div class="reauth-modal-actions">
        <button type="button" id="reauth-cancel" class="topbar-btn">Cancel</button>
        <button type="button" id="reauth-submit" class="topbar-btn topbar-btn-primary">Update &amp; retry</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  mounted = true;
  return root;
}

export function showReauthDialog(req: ReauthRequest): Promise<ReauthResult | null> {
  const root = ensureMounted();
  const message = root.querySelector<HTMLParagraphElement>(
    '#reauth-modal-message',
  )!;
  const tokenInput = root.querySelector<HTMLInputElement>(
    '#reauth-token-input',
  )!;
  const showToken = root.querySelector<HTMLInputElement>(
    '#reauth-show-token',
  )!;
  const submitBtn = root.querySelector<HTMLButtonElement>('#reauth-submit')!;
  const cancelBtn = root.querySelector<HTMLButtonElement>('#reauth-cancel')!;
  const closeBtn = root.querySelector<HTMLButtonElement>('#reauth-close')!;

  const target = req.connectionName ? `"${req.connectionName}"` : 'this agent';
  const detail = req.errorMessage ? ` Server said: ${req.errorMessage}` : '';
  message.textContent = `Connection to ${target} failed with HTTP ${req.status}. The bearer token may be expired or invalid. Update it below and retry.${detail}`;
  tokenInput.value = req.currentToken ?? '';
  tokenInput.type = 'password';
  showToken.checked = false;

  root.removeAttribute('hidden');
  setTimeout(() => tokenInput.focus(), 0);

  return new Promise(resolve => {
    const cleanup = () => {
      root.setAttribute('hidden', '');
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      root.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      tokenInput.removeEventListener('keydown', onTokenKey);
      showToken.removeEventListener('change', onShowToken);
    };
    const onSubmit = () => {
      const token = tokenInput.value.trim();
      if (!token) {
        tokenInput.focus();
        return;
      }
      cleanup();
      resolve({token});
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === root) onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    const onTokenKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onSubmit();
    };
    const onShowToken = () => {
      tokenInput.type = showToken.checked ? 'text' : 'password';
    };
    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    root.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    tokenInput.addEventListener('keydown', onTokenKey);
    showToken.addEventListener('change', onShowToken);
  });
}

export function isReauthDialogMounted(): boolean {
  return mounted;
}
