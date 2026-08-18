import * as vscode from 'vscode';

/**
 * Dotenv Safe Edit
 *
 * Registers a CustomReadonlyEditorProvider (NOT a CustomTextEditorProvider).
 * That distinction matters: because the .env file is never turned into a
 * vscode.TextDocument, it never appears in vscode.workspace.textDocuments
 * and never becomes the "active text editor". Extensions/agents that pull
 * context from the active editor or open text documents (Copilot Chat "Ask"
 * mode's implicit editor context, etc.) simply have nothing to read while
 * the file is open in Dotenv Safe Edit.
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
  // whether this line uses `KEY = value` (spaced) vs `KEY=value` (unspaced).
  spaced: boolean;
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
      webviewPanel.webview.html = getHtml(text);
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
            .map((l) => (l.isRaw ? l.raw : l.spaced ? `${l.key} = ${l.value}` : `${l.key}=${l.value}`))
            .join('\n');
          await vscode.workspace.fs.writeFile(
            document.uri,
            Buffer.from(newText + (newText.endsWith('\n') ? '' : '\n'), 'utf8')
          );
          vscode.window.setStatusBarMessage('Dotenv Safe Edit: saved', 2000);
          break;
        }
        case 'copyValue': {
          await vscode.env.clipboard.writeText(msg.value);
          vscode.window.setStatusBarMessage('Dotenv Safe Edit: value copied to clipboard', 2000);
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

function parseEnv(text: string): EnvLine[] {
  return text.split('\n').map((line): EnvLine => {
    const trimmed = line.trim();
    const isKv = trimmed !== '' && !trimmed.startsWith('#') && line.includes('=');
    if (!isKv) {
      return { isRaw: true, raw: line };
    }
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const spaced = line[idx - 1] === ' ' || line[idx + 1] === ' ';
    return { isRaw: false, key, value, spaced };
  });
}

// Tie or no key/value lines at all defaults to unspaced (most common style).
function majoritySpaced(lines: EnvLine[]): boolean {
  let spacedCount = 0;
  let unspacedCount = 0;
  for (const l of lines) {
    if (!l.isRaw) {
      if (l.spaced) {
        spacedCount++;
      } else {
        unspacedCount++;
      }
    }
  }
  return spacedCount > unspacedCount;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c] as string));
}

function getHtml(text: string): string {
  const lines = parseEnv(text);
  const nonce = String(Date.now());
  const defaultSpaced = majoritySpaced(lines);

  const rows = lines.map((l, i) => {
    if (l.isRaw) {
      return `
      <div class="raw-line" data-idx="${i}">
        <div class="reorder-group">
          <span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span>
          <div class="move-group">
            <button class="icon-btn move-up" data-idx="${i}" title="Move up" tabindex="-1">⇑</button>
            <button class="icon-btn move-down" data-idx="${i}" title="Move down" tabindex="-1">⇓</button>
          </div>
        </div>
        <input class="raw-input" data-idx="${i}" value="${esc(l.raw)}" spellcheck="false" autocomplete="off" />
        <button class="icon-btn del" data-idx="${i}" title="Delete line" tabindex="-1">✕</button>
      </div>`;
    }
    return `
      <div class="row" data-idx="${i}">
        <div class="reorder-group">
          <span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span>
          <div class="move-group">
            <button class="icon-btn move-up" data-idx="${i}" title="Move up" tabindex="-1">⇑</button>
            <button class="icon-btn move-down" data-idx="${i}" title="Move down" tabindex="-1">⇓</button>
          </div>
        </div>
        <div class="kv${l.spaced ? ' spaced' : ''}">
          <input class="key" data-idx="${i}" value="${esc(l.key)}" spellcheck="false" />
          <span class="eq">=</span>
          <input class="value masked" type="password" data-idx="${i}" value="${esc(l.value)}" spellcheck="false" autocomplete="off" />
        </div>
        <button class="icon-btn reveal" data-idx="${i}" title="Toggle visibility" tabindex="-1">⌒</button>
        <button class="icon-btn copy" data-idx="${i}" title="Copy value" tabindex="-1">⧉</button>
        <button class="icon-btn spacing-toggle" data-idx="${i}" title="Toggle spacing around =" tabindex="-1">${l.spaced ? '⇎' : '⇔'}</button>
        <button class="icon-btn del" data-idx="${i}" title="Delete row" tabindex="-1">✕</button>
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
  .toolbar {
    display: flex; gap: 8px; margin-bottom: 12px; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 5;
    background: var(--vscode-editor-background);
    padding: 8px 0; margin: -12px -16px 12px; padding-left: 16px; padding-right: 16px;
    border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
  }
  .toolbar-left, .toolbar-right { display: flex; gap: 8px; align-items: center; }
  button.action {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer;
  }
  button.action:hover { background: var(--vscode-button-hoverBackground); }
  button.action:disabled { opacity: 0.5; cursor: not-allowed; }
  button.action.secondary {
    background: var(--vscode-button-secondaryBackground, #1e9c39);
    color: var(--vscode-button-secondaryForeground, #ffffff);
  }
  button.action.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .raw-line { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; opacity: 0.65; }
  .raw-line input.raw-input {
    flex: 1; font-family: monospace; font-style: italic;
    background: transparent; border: 1px solid transparent;
    padding: 3px 6px; border-radius: 3px; color: inherit;
  }
  .raw-line input.raw-input:hover {
    background: rgba(128, 128, 128, 0.12);
  }
  .raw-line input.raw-input:focus {
    background: var(--vscode-input-background); border-color: var(--vscode-input-border, #3c3c3c);
  }
  .kv { display: flex; align-items: center; gap: 0; flex: 1; min-width: 0; }
  .kv.spaced { gap: 6px; }
  input.key, input.value {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px; border-radius: 3px; font-family: monospace;
  }
  input.key { flex: 0 0 220px; }
  input.value { flex: 1; }
  input.key.invalid, input.value.invalid {
    border-color: var(--vscode-inputValidation-errorBorder, #be1100);
  }
  .eq { opacity: 0.5; }
  .icon-btn {
    background: transparent; border: none; cursor: pointer;
    color: var(--vscode-icon-foreground, currentColor);
    opacity: 0.7; padding: 2px 4px;
  }
  .icon-btn:hover { opacity: 1; }
  .reveal, .spacing-toggle { display: inline-block; width: 1.4em; text-align: center; }
  .move-group { display: flex; gap: 0; }
  .move-group .icon-btn { padding: 2px 1px; }
  .reorder-group { display: flex; align-items: center; gap: 2px; }
  .drag-handle {
    cursor: grab; opacity: 0.6; padding: 2px 2px; user-select: none;
  }
  .drag-handle:active { cursor: grabbing; }
  .row.dragging, .raw-line.dragging { opacity: 0.35; }
  .row.drag-over-top, .raw-line.drag-over-top { border-top: 2px solid var(--vscode-focusBorder, #007acc); }
  .row.drag-over-bottom, .raw-line.drag-over-bottom { border-bottom: 2px solid var(--vscode-focusBorder, #007acc); }
  .confirm-overlay {
    position: fixed; inset: 0; z-index: 10; display: flex;
    align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }
  .confirm-box {
    display: flex; flex-direction: column; gap: 12px; align-items: center;
    background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground);
    border: 1px solid var(--vscode-editorWidget-border, transparent);
    padding: 16px 20px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    font-size: 13px;
  }
  .confirm-actions { display: flex; gap: 8px; }
  .banner {
    font-size: 12px; opacity: 0.65; margin-bottom: 10px;
  }
</style>
</head>
<body>
  <div class="banner">
    <span>🔒 Dotenv Safe Edit: This tab's content is not exposed as text to other extensions or AI context.</span>
  </div>
  <div class="toolbar">
    <div class="toolbar-left">
      <button class="action" id="revealAll">Reveal all</button>
      <button class="action secondary" id="maskAll">Mask all</button>
      <button class="action secondary" id="addRow">+ Add variable</button>
      <button class="action secondary" id="addLine">+ Add line</button>
    </div>
    <div class="toolbar-right">
      <button class="action" id="save" disabled>Save</button>
      <button class="action secondary" id="openAsText">Open as plain text&hellip;</button>
    </div>
  </div>
  <div id="rows">${rows}</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rowsEl = document.getElementById('rows');
  const saveBtn = document.getElementById('save');
  let defaultSpaced = ${defaultSpaced ? 'true' : 'false'};
  let dirty = false;

  function markDirty() {
    dirty = true;
    saveBtn.disabled = false;
  }

  // Reorders by swapping DOM position; collect() reads back in document
  // order so this is all that's needed to change the saved line order.
  function moveRow(row, dir) {
    const sibling = dir === 'up' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) {
      return;
    }
    if (dir === 'up') {
      rowsEl.insertBefore(row, sibling);
    } else {
      rowsEl.insertBefore(sibling, row);
    }
    markDirty();
  }

  // Delegated on the container so newly added rows need no extra wiring.
  let draggedRow = null;

  function getRowEl(el) {
    return el.closest('.row, .raw-line');
  }

  function clearDragOverMarkers() {
    rowsEl.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom');
    });
  }

  rowsEl.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('.drag-handle');
    const row = handle && getRowEl(handle);
    if (!row) {
      return;
    }
    draggedRow = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(row, 10, 10);
  });

  rowsEl.addEventListener('dragover', (e) => {
    if (!draggedRow) {
      return;
    }
    e.preventDefault();
    const target = getRowEl(e.target);
    clearDragOverMarkers();
    if (!target || target === draggedRow) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    target.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
  });

  rowsEl.addEventListener('drop', (e) => {
    if (!draggedRow) {
      return;
    }
    e.preventDefault();
    const target = getRowEl(e.target);
    clearDragOverMarkers();
    if (target && target !== draggedRow) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      rowsEl.insertBefore(draggedRow, before ? target : target.nextSibling);
      markDirty();
    }
  });

  rowsEl.addEventListener('dragend', () => {
    draggedRow?.classList.remove('dragging');
    clearDragOverMarkers();
    draggedRow = null;
  });

  // Recomputed only when a row's spacing is toggled, so "add row" always
  // follows the current majority instead of the one from file-open time.
  function recalcDefaultSpaced() {
    let spacedCount = 0;
    let unspacedCount = 0;
    rowsEl.querySelectorAll('.row .kv').forEach(kv => {
      if (kv.classList.contains('spaced')) {
        spacedCount++;
      } else {
        unspacedCount++;
      }
    });
    defaultSpaced = spacedCount > unspacedCount;
  }

  function showConfirmPopup(anchorEl, message, onConfirm, confirmLabel = 'Delete') {
    document.querySelector('.confirm-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = '<div class="confirm-box"><span>' + message + '</span><div class="confirm-actions"><button class="action" data-act="yes">' + confirmLabel + '</button><button class="action secondary" data-act="no">Cancel</button></div></div>';
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        close();
      }
    });
    overlay.querySelector('[data-act="yes"]').addEventListener('click', () => {
      close();
      onConfirm();
    });
    overlay.querySelector('[data-act="no"]').addEventListener('click', close);
  }

  function collect() {
    const out = [];
    rowsEl.querySelectorAll('.raw-line, .row').forEach(el => {
      if (el.classList.contains('raw-line')) {
        out.push({ isRaw: true, raw: el.querySelector('.raw-input').value });
      } else {
        const key = el.querySelector('.key').value;
        const value = el.querySelector('.value').value;
        const spaced = el.querySelector('.kv').classList.contains('spaced');
        out.push({ isRaw: false, key, value, spaced });
      }
    });
    return out;
  }

  saveBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'save', lines: collect() });
    dirty = false;
    saveBtn.disabled = true;
  });

  document.getElementById('openAsText').addEventListener('click', () => {
    showConfirmPopup(
      document.getElementById('openAsText'),
      'Opening this file as plain text will make its contents visible.',
      () => vscode.postMessage({ type: 'openAsText' }),
      'Open as plain text'
    );
  });

  document.getElementById('revealAll').addEventListener('click', () => {
    document.querySelectorAll('input.value').forEach(i => i.type = 'text');
    document.querySelectorAll('.reveal').forEach(b => b.textContent = '👁');
  });
  document.getElementById('maskAll').addEventListener('click', () => {
    document.querySelectorAll('input.value').forEach(i => i.type = 'password');
    document.querySelectorAll('.reveal').forEach(b => b.textContent = '⌒');
  });

  document.getElementById('addRow').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = '<div class="reorder-group"><span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span><div class="move-group"><button class="icon-btn move-up" title="Move up" tabindex="-1">⇑</button><button class="icon-btn move-down" title="Move down" tabindex="-1">⇓</button></div></div><div class="kv' + (defaultSpaced ? ' spaced' : '') + '"><input class="key" value="" spellcheck="false" /><span class="eq">=</span><input class="value masked" type="password" value="" spellcheck="false" autocomplete="off" /></div><button class="icon-btn reveal" title="Toggle visibility" tabindex="-1">⌒</button><button class="icon-btn copy" title="Copy value" tabindex="-1">⧉</button><button class="icon-btn spacing-toggle" title="Toggle spacing around =" tabindex="-1">' + (defaultSpaced ? '⇎' : '⇔') + '</button><button class="icon-btn del" title="Delete row" tabindex="-1">✕</button>';
    rowsEl.appendChild(div);
    wireRow(div);
    markDirty();
  });

  function wireRow(row) {
    const revealBtn = row.querySelector('.reveal');
    const copyBtn = row.querySelector('.copy');
    const delBtn = row.querySelector('.del');
    const spacingBtn = row.querySelector('.spacing-toggle');
    const moveUpBtn = row.querySelector('.move-up');
    const moveDownBtn = row.querySelector('.move-down');
    const kv = row.querySelector('.kv');
    const keyInput = row.querySelector('.key');
    const valueInput = row.querySelector('.value');

    const validate = () => {
      keyInput.classList.toggle('invalid', keyInput.value.trim() === '');
      valueInput.classList.toggle('invalid', valueInput.value.trim() === '');
    };
    validate();

    keyInput?.addEventListener('input', () => {
      validate();
      markDirty();
    });
    valueInput?.addEventListener('input', () => {
      validate();
      markDirty();
    });
    revealBtn?.addEventListener('click', () => {
      valueInput.type = valueInput.type === 'password' ? 'text' : 'password';
      revealBtn.textContent = valueInput.type === 'password' ? '⌒' : '👁';
    });
    copyBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'copyValue', value: valueInput.value });
    });
    spacingBtn?.addEventListener('click', () => {
      kv.classList.toggle('spaced');
      spacingBtn.textContent = kv.classList.contains('spaced') ? '⇎' : '⇔';
      recalcDefaultSpaced();
      markDirty();
    });
    moveUpBtn?.addEventListener('click', () => moveRow(row, 'up'));
    moveDownBtn?.addEventListener('click', () => moveRow(row, 'down'));
    delBtn?.addEventListener('click', () => {
      showConfirmPopup(delBtn, 'Delete this variable?', () => {
        row.remove();
        markDirty();
      });
    });
  }

  rowsEl.querySelectorAll('.row').forEach(wireRow);

  document.getElementById('addLine').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'raw-line';
    div.innerHTML = '<div class="reorder-group"><span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span><div class="move-group"><button class="icon-btn move-up" title="Move up" tabindex="-1">⇑</button><button class="icon-btn move-down" title="Move down" tabindex="-1">⇓</button></div></div><input class="raw-input" value="" spellcheck="false" autocomplete="off" /><button class="icon-btn del" title="Delete line" tabindex="-1">✕</button>';
    rowsEl.appendChild(div);
    wireRawRow(div);
    div.querySelector('.raw-input').focus();
    markDirty();
  });

  function wireRawRow(row) {
    const input = row.querySelector('.raw-input');
    const moveUpBtn = row.querySelector('.move-up');
    const moveDownBtn = row.querySelector('.move-down');
    const delBtn = row.querySelector('.del');
    input?.addEventListener('input', () => {
      // Auto-prefix so free text always reads as a comment unless left blank.
      if (input.value !== '' && !input.value.startsWith('#')) {
        const pos = input.selectionStart ?? input.value.length;
        input.value = '# ' + input.value;
        input.setSelectionRange(pos + 2, pos + 2);
      }
      markDirty();
    });
    moveUpBtn?.addEventListener('click', () => moveRow(row, 'up'));
    moveDownBtn?.addEventListener('click', () => moveRow(row, 'down'));
    delBtn?.addEventListener('click', () => {
      showConfirmPopup(delBtn, 'Delete this line?', () => {
        row.remove();
        markDirty();
      });
    });
  }

  rowsEl.querySelectorAll('.raw-line').forEach(wireRawRow);
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
