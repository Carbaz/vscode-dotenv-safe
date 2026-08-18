# Dotenv Safe

Opens files matching `*.env`, `*.env.*`, `.env`, or `.env.*` in an isolated
custom editor instead of the normal text editor.

## Why

VS Code's normal text editor turns every open file into a `TextDocument`,
which is exactly what tools like GitHub Copilot Chat's "Ask" mode read as
implicit context (the active editor). If a `.env` file is left open and you
switch to Ask mode, its contents can get pulled into the chat automatically.

Dotenv Safe registers a **non-text custom editor** for `.env` files. The file is
still read from disk to display it, but it never becomes a `TextDocument` and
never shows up as an "active text editor" — so tools that read open
tabs/editors have nothing to read while it's open here.

This does **not** protect against:

* Agents/tools with direct filesystem or shell access (`cat .env`, file-read tools, etc.)
* Anyone using "Open As... > Text Editor" to bypass Dotenv Safe deliberately
* Anything that indexes your workspace on disk directly (e.g. `@workspace`
  style search over files, if it bypasses editor state)

It closes one specific, real hole: forgetting to close the tab before
switching to chat.

## Features

* Values masked by default (`type="password"` style inputs)
* Per-row reveal/mask toggle, or reveal/mask all
* Copy a single value to clipboard without revealing it on screen
* Add / edit / delete variables, saved directly to disk
* Comments and blank lines preserved on save
* "Open as Plain Text..." escape hatch when you deliberately want the normal
  editor (e.g. to diff, or to use VS Code's find/replace)
* Bypass per-file: right-click the file → **Open With...** → **Text Editor**

## Known limitations

* Early version — no packaged release yet, build the `.vsix` yourself (see
  below).
* Values wrapped in quotes (e.g. `KEY="value"`) are not parsed correctly
  yet — the wrapping quotes get baked into the displayed value.

## Install

There's no published release yet, so build the `.vsix` locally:

1. `npm install`
2. `npm run package` (runs `tsc` then `vsce package`)
3. VS Code → Extensions view → `...` menu (top right) → **Install from
   VSIX...**
4. Pick the generated `dotenv-safe-0.0.1.vsix`

Works for matching files anywhere on disk, including outside the current
workspace folder.

## Uninstall

* Extensions view → Dotenv Safe → gear icon → Uninstall
