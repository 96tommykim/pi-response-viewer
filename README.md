# pi-response-viewer

A local, output-only browser reader for [Pi](https://github.com/earendil-works/pi). Pi remains the input surface and terminal fallback; the viewer presents assistant text in a focused reading layout.

## Features

- Per-turn response history, limited to 30 responses and 2 MiB in memory
- Streaming Markdown with sanitized HTML, safe links, tables, lists, and headings
- Local Prism highlighting for supported fenced languages
- Copy, wrap, and expand controls for code blocks
- Response outline, deep links, permalinks, smart follow, and history navigation
- Responsive dark/light reader and Print/Save as PDF styles
- Automatic reconnect status and a manual `/viewer` command

## Install

```sh
pi install npm:pi-response-viewer
```

Or install directly from GitHub:

```sh
pi install git:github.com/96tommykim/pi-response-viewer
```

Restart Pi after installation. The viewer opens once on the first agent run; use `/viewer` to reopen it.

## Privacy and security

The viewer binds to `127.0.0.1` on an ephemeral port with an unguessable path token. It accepts tokenized GET requests only and sends restrictive CSP and no-store headers. It has no network requests, telemetry, CORS, browser persistence, or browser input.

Only assistant text is displayed. User messages, thinking, tool calls and results, and provider error details stay out of the browser. The extension does not run in print, JSON, RPC, or subagent-child sessions.

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
