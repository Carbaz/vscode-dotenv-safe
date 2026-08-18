import * as vscode from 'vscode';

/**
 * Dotenv Safe
 *
 * Registers a CustomReadonlyEditorProvider (NOT a CustomTextEditorProvider).
 * That distinction matters: because the .env file is never turned into a
 * vscode.TextDocument, it never appears in vscode.workspace.textDocuments
 * and never becomes the "active text editor". Extensions/agents that pull
 * context from the active editor or open text documents (Copilot Chat "Ask"
 * mode's implicit editor context, etc.) simply have nothing to read while
 * the file is open in Dotenv Safe.
 *
 * The file is still read from disk to render it (there is no way around
 * that - something has to display the content) and still fully readable by
 * anything with direct filesystem or shell access. This closes the "open
 * tab got auto-included in chat context" hole specifically, not filesystem
 * access in general.
 */

// Discriminated union: a line is either a raw passthrough (comments, blank
// lines, anything we don't confidently parse) or a real key/value pair.
// TS forces every consumer to narrow on `isRaw` before touching key/value,
// which is what the original JS bug (reading .value on a raw line) skipped.
type RawLine = {
  isRaw: true;
  raw: string;
};

type KvLine = {
  isRaw: false;
  key: string;
  value: string;
};

type EnvLine = RawLine | KvLine;

type WebviewToExtensionMessage =
  | { type: 'save'; lines: EnvLine[] }
  | { type: 'copyValue'; value: string }
  | { type: 'openAsText' };

class EnvDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class EnvEditorProvider implements vscode.CustomReadonlyEditorProvider<EnvDocument> {
  async openCustomDocument(uri: vscode.Uri): Promise<EnvDocument> {
    return new EnvDocument(uri);
  }

  async resolveCustomEditor(
    document: EnvDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };

    const render = async () => {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      const text = Buffer.from(bytes).toString('utf8');
      webviewPanel.webview.html = getHtml(document.uri.fsPath, text);
    };

    await render();

    // React to external changes to the file (e.g. edited elsewhere).
    const watcher = vscode.workspace.createFileSystemWatcher(document.uri.fsPath);
    watcher.onDidChange(render);
    webviewPanel.onDidDispose(() => watcher.dispose());

    webviewPanel.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
      switch (msg.type) {
        case 'save': {
          const newText = msg.lines
            .map((l) => (l.isRaw ? l.raw : `${l.key}=${l.value}`))
            .join('\n');
          await vscode.workspace.fs.writeFile(
            document.uri,
            Buffer.from(newText + (newText.endsWith('\n') ? '' : '\n'), 'utf8')
          );
          vscode.window.setStatusBarMessage('Dotenv Safe: saved', 2000);
          break;
        }
        case 'copyValue': {
          await vscode.env.clipboard.writeText(msg.value);
          vscode.window.setStatusBarMessage('Dotenv Safe: value copied to clipboard', 2000);
          break;
        }
        case 'openAsText': {
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        }
      }
    });
  }
}

/**
 * NOTE: known bug still present here on purpose (kept as-is during the TS
 * migration, tracked in TODO.md) — this does not trim whitespace around
 * `=` and does not strip wrapping quotes, so `DATE = "872835240"` currently
 * round-trips with the leading space and literal quotes baked into
 * `value`. Fixing that is backlog item covering the parser rewrite.
 */
function parseEnv(text: string): EnvLine[] {
  return text.split('\n').map((line): EnvLine => {
    const trimmed = line.trim();
    const isKv = trimmed !== '' && !trimmed.startsWith('#') && line.includes('=');
    if (!isKv) {
      return { isRaw: true, raw: line };
    }
    const idx = line.indexOf('=');
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    return { isRaw: false, key, value };
  });
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c] as string));
}

function getHtml(filePath: string, text: string): string {
  const lines = parseEnv(text);
  const nonce = String(Date.now());

  const rows = lines.map((l, i) => {
    if (l.isRaw) {
      return `<div class="raw-line" data-idx="${i}">${esc(l.raw) || '&nbsp;'}</div>`;
    }
    return `
      <div class="row" data-idx="${i}">
        <input class="key" data-idx="${i}" value="${esc(l.key)}" spellcheck="false" />
        <span class="eq">=</span>
        <input class="value masked" type="password" data-idx="${i}" value="${esc(l.value)}" spellcheck="false" autocomplete="off" />
        <button class="icon-btn reveal" data-idx="${i}" title="Toggle visibility">👁</button>
        <button class="icon-btn copy" data-idx="${i}" title="Copy value">⧉</button>
        <button class="icon-btn del" data-idx="${i}" title="Delete row">✕</button>
      </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 12px 16px;
  }
  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
  .toolbar .path { opacity: 0.6; font-size: 12px; margin-left: auto; }
  button.action {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer;
  }
  button.action:hover { background: var(--vscode-button-hoverBackground); }
  button.action.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .raw-line { opacity: 0.55; font-family: monospace; white-space: pre; margin-bottom: 4px; min-height: 1.2em; }
  input.key, input.value {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px; border-radius: 3px; font-family: monospace;
  }
  input.key { flex: 0 0 220px; }
  input.value { flex: 1; }
  .eq { opacity: 0.5; }
  .icon-btn {
    background: transparent; border: none; cursor: pointer;
    color: var(--vscode-icon-foreground, currentColor);
    opacity: 0.7; padding: 2px 4px;
  }
  .icon-btn:hover { opacity: 1; }
  .footer { margin-top: 14px; display: flex; gap: 8px; }
  .banner {
    font-size: 12px; opacity: 0.65; margin-bottom: 10px;
  }
</style>
</head>
<body>
  <div class="banner">🔒 Dotenv Safe &mdash; values masked by default. This file is not exposed as a text document/tab to other extensions or AI context.</div>
  <div class="toolbar">
    <button class="action" id="revealAll">Reveal all</button>
    <button class="action secondary" id="maskAll">Mask all</button>
    <button class="action secondary" id="addRow">+ Add variable</button>
    <span class="path">${esc(filePath)}</span>
  </div>
  <div id="rows">${rows}</div>
  <div class="footer">
    <button class="action" id="save">Save</button>
    <button class="action secondary" id="openAsText">Open as plain text&hellip;</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rowsEl = document.getElementById('rows');

  function collect() {
    const out = [];
    rowsEl.querySelectorAll('.raw-line, .row').forEach(el => {
      if (el.classList.contains('raw-line')) {
        out.push({ isRaw: true, raw: el.textContent === '\\u00a0' ? '' : el.textContent });
      } else {
        const key = el.querySelector('.key').value;
        const value = el.querySelector('.value').value;
        out.push({ isRaw: false, key, value });
      }
    });
    return out;
  }

  document.getElementById('save').addEventListener('click', () => {
    vscode.postMessage({ type: 'save', lines: collect() });
  });

  document.getElementById('openAsText').addEventListener('click', () => {
    vscode.postMessage({ type: 'openAsText' });
  });

  document.getElementById('revealAll').addEventListener('click', () => {
    document.querySelectorAll('input.value').forEach(i => i.type = 'text');
  });
  document.getElementById('maskAll').addEventListener('click', () => {
    document.querySelectorAll('input.value').forEach(i => i.type = 'password');
  });

  document.getElementById('addRow').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = '<input class="key" value="" spellcheck="false" /><span class="eq">=</span><input class="value masked" type="password" value="" spellcheck="false" autocomplete="off" /><button class="icon-btn reveal">👁</button><button class="icon-btn copy">⧉</button><button class="icon-btn del">✕</button>';
    rowsEl.appendChild(div);
    wireRow(div);
  });

  function wireRow(row) {
    const revealBtn = row.querySelector('.reveal');
    const copyBtn = row.querySelector('.copy');
    const delBtn = row.querySelector('.del');
    const valueInput = row.querySelector('.value');

    revealBtn?.addEventListener('click', () => {
      valueInput.type = valueInput.type === 'password' ? 'text' : 'password';
    });
    copyBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'copyValue', value: valueInput.value });
    });
    delBtn?.addEventListener('click', () => row.remove());
  }

  rowsEl.querySelectorAll('.row').forEach(wireRow);
</script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new EnvEditorProvider();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('dotenvSafe.secureEditor', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotenvSafe.openAsText', async () => {
      const editor = vscode.window.activeTextEditor;
      const uri = editor?.document.uri;
      if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
      }
    })
  );
}

export function deactivate(): void {}
