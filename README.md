# pi-response-viewer

A local, output-only browser reader for [Pi](https://github.com/earendil-works/pi). Pi remains the input surface and terminal fallback; the viewer presents each turn — prompt, assistant text and thinking, and tool steps — in a focused reading layout.

## Features

- Per-turn response history, limited to 30 responses and 2 MiB in memory
- Complete turns: every assistant message is kept, so text written before each tool call stays visible, separated by a rule
- Prompt header on every response, plus inline tool steps and collapsible thinking
- Streaming Markdown with sanitized HTML, safe links, tables, lists, and headings
- Local Prism highlighting for supported fenced languages
- Mermaid diagrams and collapsible file trees for `mermaid` / `tree` fences
- Copy, wrap, and expand controls for code blocks
- `/viewer on|off` to enable or disable the viewer per session
- Searchable Response Navigator with Cmd/Ctrl+K focus, response status, and history navigation
- Rich Mermaid, tree, unified diff, JSON tree, and sortable CSV fences; `title=` / `filename=` code labels
- Explicit client-side Markdown copy/download for the selected response or retained history
- Print current response or all retained responses, plus responsive dark/light reader and PDF styles
- Automatic reconnect status and a manual `/viewer` command

## Install

```sh
pi install git:github.com/96tommykim/pi-response-viewer
```

Restart Pi after installation. The viewer opens once on the first agent run; use `/viewer` to reopen it, or `/viewer off` to disable it for the session.

## Privacy and security

The viewer binds to `127.0.0.1` on an ephemeral port with an unguessable path token. It accepts tokenized GET requests only and sends restrictive CSP and no-store headers. It has no automatic or background network requests, telemetry, CORS, automatic browser persistence, or browser-to-Pi prompt/input channel. Navigator search stays in the local reader and is never sent to Pi. Markdown download and print occur only after an explicit browser action and are client-side.

The reader shows the prompt that opened each turn, the assistant's text and thinking, and each tool step — name, a one-line input summary, status, and the result, capped at 8 KiB per item. Provider error details stay out of the browser. Content over a cap is cut when captured, not when displayed, so the terminal remains the complete record. The extension does not run in print, JSON, RPC, or subagent-child sessions.

## Development

Node 22.19+ and a global Pi installation are required for typechecking.

```sh
npm ci
npm test
npm run package:check
```

`test:browser` uses a locally installed Chrome or Chromium when available and skips otherwise.

## License

Project code is MIT under the root [LICENSE](LICENSE). Bundled third-party assets retain their respective license texts under `extensions/response-viewer/vendor`.
