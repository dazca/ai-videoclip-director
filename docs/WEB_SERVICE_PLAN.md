# Director Workbench as a web service: plan

Status: proposal, 2026-10-04. Scope: put the workbench on a page of azemar.eu as a static site, with the source at
https://github.com/dazca/ai-videoclip-director (Help > Source on GitHub). Users keep their projects on their own
machines and connect their own Claude Code session. Every web-platform claim below is dated. Re-check them before
building each phase, because the browser features this depends on (Local Network Access, File System Access, OPFS
quotas) changed during 2025-2026.

## 0. The short version

- **The UI is ready to be static.** It has no build step, no framework and no CDN dependency. It already survives
  without a server (`/api/config` and `/api/events` fail silently), so a read-only demo can be up in a day or two.
- **Everything else is server-side today.** That covers saving, projects, snapshots, live reload, thumbnails
  (ffmpeg), the agent ops and the live UI channel. Each of these needs a home in the browser or in a small local
  helper.
- **The hardest problem is a file space that the agent and the browser share.** Claude Code runs on the user's disk
  and downloads generated clips there. A web page lives in a sandbox. Whatever we build, the project has to live
  somewhere both can read and write: a folder on disk, with live change notification and the same rules (rev, no
  self-approval, cost cap) on both sides.
- **Recommendation.**
  - **Primary:** a local helper started with one command (`npx`), which is today's `serve.mjs` and the MCP server in
    one process. It owns a folder on disk. The hosted page connects to it on `127.0.0.1` after a one-time pairing and
    the browser's Local Network Access prompt.
  - **Fallbacks:** the same helper serves the same UI at `http://localhost`, which covers Safari, offline use and
    "download it" users. A browser-only mode stores data in a granted folder (Chromium) or in OPFS (all browsers),
    with zip import and export, for people who only want to plan.
  - **Later and optional:** a browser extension and a cloud relay. They do not remove the local install, which is
    the thing they would need to do to be worth their cost.

## 1. Inventory: what the server does today and where each piece goes

Legend for the last column:
- **Browser:** moves into the page.
- **Helper:** needs the local helper.
- **Static:** served as a plain file.
- **Drop:** not needed in the web build.

| Capability (today) | Where it lives now | In the static web build | Home |
|---|---|---|---|
| Static UI files (`index.html`, `app.*`, `core/`, `js/`, `tabs/`, `dock.html`) | `serve.mjs` GET, with a deny-list for `tools/`, `mcp/`, `lib/`… | Copied by an allow-list build script into `dist/` | **Static** |
| Redirect from a bare `/` to `?project=<default>` | `serve.mjs` | Page-side: the last project opened (localStorage), else the demo | **Browser** |
| `GET /api/config` (media roots, private regex, default project) | `serve.mjs` from `workbench.config.json` | Per-workspace `workbench.config.json` read through the Storage layer. In browser modes, media roots become extra granted folders | **Browser** (Helper when used) |
| `GET /api/status` (pages open, data dir) | `serve.mjs` | Only meaningful with the helper. The page shows a connection badge instead | **Helper** |
| Project files `GET /data/<p>/...` (JSON, peaks, thumbs, audio, render, with Range) | `serve.mjs` `sendFile` | A Service Worker serves `data/<p>/...` from the active backend (OPFS / FSA / IDB), with Range responses built from `File.slice()`. `mediaUrl()` and every `<video src>` stay unchanged | **Browser** |
| Media outside the project `GET /media/<path>` (configured `media_roots`, read-only, private local-only) | `serve.mjs` | FSA: one granted folder handle per media root. OPFS: files must be imported (copied). Helper: unchanged | **Browser** / **Helper** |
| `POST /api/save/<file>` (rev check, 409 + current copy, atomic temp+rename) | `serve.mjs` + `lib/store.mjs` | `Storage.writeJSON(p, file, data, {baseRev})`: read, compare rev, write. FSA `createWritable()` writes to a swap file and replaces the target on `close()`, so a write is atomic per file | **Browser** |
| `GET /api/events` (SSE, `fs.watch` of the data folder) | `serve.mjs` | Helper: SSE (unchanged). FSA: `FileSystemObserver` where it exists, else polling of `lastModified` on the ~15 small JSON files every 1-2 s. OPFS/IDB: a BroadcastChannel between tabs (only the page writes) | **Browser** / **Helper** |
| Projects list / new / duplicate / delete | `lib/store.mjs` | Generic implementation on top of the Storage primitives (list dir, copy tree, remove). `data/_template/` ships in `dist/` | **Browser** |
| Snapshots save / list / restore (`.snapshots/<stamp>-<slug>/`, auto-snapshot before restore) | `lib/store.mjs` | Same layout, same code, on the Storage primitives | **Browser** |
| Agent ops `POST /api/op/<name>` (24 MCP tools: song, timeline, shots, entities, media, notes, approvals, requests, costs) | `lib/store.mjs` `ops` (Node `fs`) | Split `lib/store.mjs` into an isomorphic `core/ops.js` that works over the Storage interface, plus a thin Node adapter. The page, the helper and the MCP server then run the same rules | **Browser** + **Helper** |
| Thumbnails and 8-frame hover strips (ffmpeg), probe (ffprobe), in `media_add` | `lib/store.mjs` `makeThumbs`, `ffprobe` | Browser: `<video>` seek + `canvas` → JPEG blob; `HTMLMediaElement` metadata for duration and size; WebCodecs (or Mediabunny) only for codecs `<video>` will not decode. Helper: ffmpeg, unchanged and better | **Browser** (Helper preferred) |
| New project from a song (`importers/new_project.mjs`: ffmpeg decode, peaks, energy, LRC parsing, beat grid) | Node CLI | Port to the page: `decodeAudioData()` → the same peaks / RMS code (pure math). This becomes **File > New from song…** | **Browser** |
| Live UI channel `POST /api/ui` + `/api/ui/ack` (agent `ui_focus`: seek, select, preview, toast, open project) | `serve.mjs` | Needs a live path from the agent to the page: helper (SSE/WS) or relay | **Helper** |
| `POST /api/reveal` (Explorer at a file) | `serve.mjs` spawns explorer | Impossible from a page. Helper only. In browser modes, offer "Copy path" or "Download" | **Helper** / **Drop** |
| Private rule (`private_media` regex, `thumbs/priv_*`, `private/`): served to localhost only, scrubbed from exports | `serve.mjs` + `core/projects.js scrub()` | Browser modes serve nothing to anyone, so the rule becomes "never leaves this browser unless exported". `scrub()` stays. Zip export excludes private files unless "include private (personal backup)" is ticked | **Browser** |
| Exports: JSON bundle, shot list CSV, printable storyboard | Already in the page (`core/projects.js`) | Unchanged. The storyboard's image URLs become blob/SW URLs, so "print to PDF" works | **Browser** (exists) |
| HyperFrames HTML package exporter (`exporters/hyperframes-html/`, Node + headless Chromium) | CLI | Stays a CLI (helper or the agent runs it). Not in the static build | **Helper** / CLI |
| Owner's importers (`azemar_import.py`, `azemar_extract_edl.mjs`) | CLI | Stay in the repo as worked examples. Not in the build | **Drop** (from web) |
| MCP server (`mcp/server.mjs`, stdio; HTTP when the server is up, files otherwise) | Node | Unchanged in spirit. Published on npm. Gains the bridge (section 3) | **Helper** |
| Headless verify (`tools/verify.mjs`), MCP e2e (`mcp/test.mjs`) | Node + puppeteer-core | CI only (GitHub Actions), plus new storage-backend tests | CI |
| `allow_remote_ops` / `isLocal()` trust model | `serve.mjs` | Replaced by pairing tokens and Origin/Host checks (see 3.5). **A security fix is needed before any hosted page talks to it** | **Helper** |
| Layout, recent projects, keybindings cache (localStorage), dock pop-out (BroadcastChannel) | Page | Unchanged. Already browser-only | **Browser** (exists) |

**Security finding to fix first (v1 prerequisite, independent of hosting).** `serve.mjs` trusts any request from
`127.0.0.1` and parses POST bodies whatever their content type. Any website the user visits can therefore send a
"simple" `text/plain` POST to `http://localhost:8140/api/op/set_states`, `/api/restore` or `/api/projects/delete`
without a CORS preflight. A DNS-rebinding page can also read every project file, private ones included, because the
request comes from localhost. Chrome 142+ (Oct 2025) and recent Firefox now put a permission prompt in front of
such requests, which reduces the risk. Safari, older browsers and non-browser clients still need the fix:
- require `content-type: application/json`;
- check `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`} (defeats DNS rebinding);
- check `Origin` against an allow-list;
- require a bearer token on every `/api/*` call.

## 2. Storage abstraction

### 2.1 Interface

One module, `core/storage/`, chosen at boot. Everything the page reads or writes goes through it. `js/store.js`'s
`getJSON` / `mutate` / `listen` and `core/projects.js`'s `call()` are rewritten on top of it.

```js
// core/storage/index.js
/** @typedef {{kind:'helper'|'fsa'|'opfs'|'idb'|'static', label:string,
 *   caps:{write:boolean, watch:'push'|'observe'|'poll'|'tabs'|false, thumbs:'native'|'browser',
 *         agent:boolean, reveal:boolean, mediaRoots:boolean, quota?:{usage:number, quota:number, persisted:boolean}}}} Info */
export interface Storage {
  info(): Info
  // workspace = a folder with projects/<id>/ and an optional workbench.config.json
  listProjects(): Promise<{id, title, modified, snapshots}[]>
  readJSON(p, path, dflt?): Promise<any>
  writeJSON(p, path, data, {baseRev}?): Promise<{rev}>          // throws Conflict{current} on a stale rev (today's 409)
  readFile(p, path): Promise<Blob>                              // lazy File for fsa/opfs: no full read into memory
  writeFile(p, path, blob | ReadableStream): Promise<void>
  list(p, dir): Promise<{name, kind, size, modified}[]>
  remove(p, path): Promise<void>
  url(p, path): string                                          // same-origin URL served by the Service Worker (or the helper)
  watch(p, onFiles: (files: string[]) => void): () => void
  // generic on top of the primitives (helper overrides with its HTTP endpoints)
  createProject(id, title), duplicateProject(from, to, reset), deleteProject(id)
  snapshot(p, message), listSnapshots(p), restore(p, id)
  op(p, name, args): Promise<any>                               // core/ops.js over this storage; helper -> POST /api/op
}
```

`core/ops.js` is today's `lib/store.mjs` `ops` with `fs` calls replaced by Storage calls. That is about 515 lines,
mostly pure logic. Node keeps a `NodeStorage` adapter, so the MCP server, the helper and the page share one rulebook:
- rev on shared files;
- `t0 < t1`;
- request lifecycle `draft → approved → queued → running → done | rejected`;
- the cost cap;
- `done` needs outputs and the actual cost;
- costs recorded in `costs.json`;
- outputs registered as media.

### 2.2 Backends

**(a) File System Access (FSA): a folder the user grants.** Chromium only (Chrome, Edge, Opera, Vivaldi; Brave hides
it behind a flag).
- `showDirectoryPicker({mode:'readwrite', id:'workbench'})` returns a `FileSystemDirectoryHandle`. Store it in
  IndexedDB (handles are structured-cloneable).
- On the next visit, call `handle.queryPermission()` and then, in a click handler, `requestPermission()`.
- Since **Chrome 122 (Feb 2024)** that prompt is three-way: "Allow this time / Allow on every visit / Don't allow".
  "Every visit" persists until revoked, so returning users get one click or none.
- **Firefox:** `showDirectoryPicker` is not implemented and Mozilla's position is negative.
- **Safari:** not implemented. Safari ships only OPFS and `getFile()` on handles from drag-and-drop or `<input>`.
- Status checked 2026-10-04. Fallback for reading a folder once: `<input type=file webkitdirectory>` (all browsers,
  read-only, no handle to write back).
- **Live changes made by the agent:**
  - `FileSystemObserver` reached an Intent to Ship for Chrome 133 desktop after an origin trial from Chrome 129.
    MDN still marks it experimental and non-standard (page dated Jul 2025). Use it where present, behind feature
    detection.
  - Otherwise poll `getFile().lastModified` of the ~15 small JSON files every 1.5 s while the tab is visible. This is
    cheap and needs no permission.
- **Why it matters most:** the user can grant **the same folder that Claude Code works in**. Agent and page then
  share files with no server at all (section 3, option A0).
- **Gotchas:**
  - The picker refuses system folders (the home folder root, Windows, Program Files…).
  - Permission is per handle. Media roots outside the project are separate grants.
  - A user who denies the grant loses access until they click again.
  - Writes to a file that is also open in another program can fail on Windows (the same locking issue `writeAtomic`
    already retries around).

**(b) Origin Private File System (OPFS): all modern browsers.** `navigator.storage.getDirectory()` works in Chrome,
Edge, Firefox and Safari (desktop and iOS). It is fast and handles large files with streaming writes
(`createWritable`, and `createSyncAccessHandle` in workers). The user cannot see the files in their own file manager,
so zip export is the way out. Quotas (MDN, page dated 2026-01-05):

| Browser | Best-effort | After `navigator.storage.persist()` |
|---|---|---|
| Chromium | up to 60 % of total disk per origin | same |
| Firefox | min(10 % of disk, 10 GiB per site group) | up to 50 % of disk, no group limit |
| Safari (browser app) | ~60 % of disk per origin (80 % total) | same. **ITP: script-written storage is deleted after 7 days of Safari use without a user interaction on the site** |

- Call `persist()` after the first project is created, which is a user-meaningful moment. Show
  `navigator.storage.estimate()` in Settings > Storage.
- Safari's 7-day rule means an untouched project can disappear. The UI must show "last backup" and nag for a zip
  export (or point to the helper) on Safari.

**(c) IndexedDB fallback.** Only for browsers without OPFS (none current) and for small state: handles, the pairing
token, recent projects. Do not store media in IDB when OPFS exists.

**(d) The local Node helper (downloadable / desktop mode).** Today's `serve.mjs` keeps its HTTP API, with section
1's security fix and a token. `HelperStorage` maps every method onto the existing endpoints. It is the only backend
with:
- true file watching (SSE);
- ffmpeg thumbnails and probing;
- `reveal`;
- media roots anywhere on disk;
- an agent that works while the page is closed.

**Static (read-only):** the demo in `dist/data/demo/`, read with `fetch`. This is v0.

### 2.3 Which backend is active

The top bar shows the backend as a small badge: `Folder · my-videoclips`, `Browser storage · 1.2 GB`,
`Local helper · 127.0.0.1:8140`, `Demo (read-only)`.

- One backend per session writes.
- A project can be moved between backends with **File > Move project to…**, which is export plus import.
- If both a granted folder and a helper pointing at the same folder are available, the helper wins (it watches and
  has ffmpeg) and FSA is the fallback when the helper is down.

### 2.4 Zip import and export

- Vendor **fflate** (MIT, a few KB). Its streaming `Zip` with `ZipPassThrough` (store, no deflate) handles media, so a
  2 GB project never sits in memory.
- Write the output with FSA `showSaveFilePicker()` where available, else a streamed download (a Service Worker
  response; a Blob for small JSON-only bundles).
- Two options:
  - **Project only (JSON, peaks, thumbs).** A few MB. This is the "send to a friend / back up" default.
  - **With media.** Opt-in, shows the total size first.
- Private files are excluded unless "include private files (personal backup)" is ticked. Every path goes through
  `scrub()`.
- Import: drop a zip anywhere or use **File > Import project…**. The zip is validated (`project.json`, ids, no `..`
  paths) and unzipped into the active backend.
- The zip layout equals the folder layout, so a zip can be unpacked by hand and opened with the helper.

### 2.5 Media in the browser

- **Playback and seeking:** the Service Worker answers `Range` requests by slicing the `File`. `<video>` seeks work
  exactly as with `serve.mjs`. Nothing is read whole.
- **Thumbnails:** an offscreen `<video>` (muted, `preload=metadata`), `currentTime = t` → `seeked` →
  `drawImage` → `canvas.convertToBlob({type:'image/jpeg', quality:.7})`. 240 px, sheets 600 px, the 8-frame strip
  tiled into one canvas. Same names as today (`thumbs/m_*.jpg`, `s_*.jpg`, `priv_*.jpg`), so helper and browser
  outputs are interchangeable. Run them in a queue of two at a time so the UI stays responsive.
- **Codecs `<video>` will not play** (ProRes, some HEVC on Firefox): use WebCodecs. Chromium has had it since 94,
  Firefox desktop since 130 and Safari fully since 26 (2025); Firefox Android lacks it. Use it through
  **Mediabunny** (demux + decode, MPL-2.0) for metadata without decoding. If that fails too, show "thumbnail needs
  the helper" and keep the file.
- **ffmpeg.wasm:** do not bundle it.
  - The single-thread core is ~31 MB, runs on the main thread and is 10-100× slower than native.
  - The multithread core needs `SharedArrayBuffer`, which means COOP/COEP headers. Those break cross-origin loads
    from the helper unless it sends CORP headers.
  - Only lazy-load it if a real need appears (transcoding for the HyperFrames package in the browser). That is not
    planned.
- **Audio import:** `decodeAudioData` on mp3/wav/m4a/ogg (Safari has no ogg). A 4-minute stereo song is ~85 MB of
  float32 for a few seconds. Then the existing peaks (5 ms min/max int8 base64) and RMS code, ported from
  `new_project.mjs`.
- **Sizes:** a typical project's JSON is <1 MB, peaks ~140 KB per stem, thumbs a few MB. The heavy part is renders
  and clips (hundreds of MB to GBs). That is why the browser modes reference media where they are (FSA) or copy them
  once (OPFS) and never re-encode.

### 2.6 Privacy

- Nothing leaves the machine unless the user exports a zip or connects an agent.
- No analytics, no cookies. Cloudflare's own edge logs (IP, URL) are the only server-side trace and they contain no
  project data, because project data is never requested from the site.
- The page never calls a paid API (today's rule stays). Provider keys never touch the page (section 5).

## 3. Connecting Claude Code

What has to be preserved: the 24 MCP tools, resources and the `director-session` prompt; the director seeing agent
writes live; `ui_focus` with acknowledgement; and the rules (only the director approves, cost cap, `done` needs
outputs).

### 3.1 Options compared (as of 2026-10-04)

**A0. No bridge: shared folder, files mode.** The user grants the page (FSA) the folder Claude Code works in. The MCP
server runs in its existing files mode (`WORKBENCH_OFFLINE=1`): it reads and writes JSON with the same ops. The page
sees changes through polling or `FileSystemObserver`.

| | |
|---|---|
| Install | `claude mcp add workbench -- npx -y <pkg> mcp --dir .` (Node needed); no port |
| Browsers | Chromium only |
| What you lose | `ui_focus`; agent-side rules hold only if the agent uses the tools rather than raw edits; live latency 1-2 s |
| Security | No listening socket; nothing new to attack |
| From an https page | Works: FSA is a secure-context API |

**A. Local helper with an HTTP/SSE bridge on localhost (recommended primary).** One Node process (the MCP stdio
server) also starts the HTTP API on `127.0.0.1:8140` if the port is free. If another instance owns the port, it acts
as a client, as `mcp/server.mjs` already does. The hosted page at `https://director.azemar.eu` uses `HelperStorage`
against `http://127.0.0.1:8140`.

| | |
|---|---|
| Install | Same one line as A0. Optionally `npx <pkg> serve` without Claude |
| Browsers | **Chrome/Edge 142+ (Oct 2025):** fetch to loopback from a public https page triggers the Local Network Access prompt ("look for and connect to devices on your local network"). It is granted once per site, and permission-gated local requests are exempt from mixed-content blocking. Use `fetch(url, {targetAddressSpace:'loopback'})`, falling back to `'local'` on versions that use that value. WebSockets were brought under LNA in Chrome 147 (Apr 2026). **Firefox:** loopback from https is allowed by the mixed-content spec; Firefox's own LNA prompt is enabled with ETP Strict from 149 and rolling out to everyone from 151 (2026), with a `LocalNetworkAccess` enterprise policy since 145. **Safari:** blocks `http://127.0.0.1` from https pages as mixed content (WebKit bug 171934, open). Safari users open the UI from the helper itself (`http://localhost:8140`), option C |
| What you lose | Nothing: every faculty works, including ffmpeg, reveal and the agent working with the page closed |
| Security | A listening port, so it needs the pairing, token, Origin/Host checks and CORS of 3.5 (and section 1's fix) |
| From an https page | Yes, through the LNA permission |

Use SSE through `fetch()` streaming rather than `EventSource`, so the token can go in a header. This avoids
WebSockets: one HTTP mechanism, already implemented.

**B. Browser extension (MV3, Chromium + Firefox).** Two shapes:
- **B1. Extension + Native Messaging.** The extension calls `runtime.connectNative('eu.azemar.workbench')`. The
  browser spawns a native host that speaks JSON over stdio and relays to the MCP process through a local pipe.
  - Install: the extension, plus a native host manifest registered on disk (Windows: a registry key per browser;
    macOS/Linux: a JSON file in a per-browser folder). That needs an installer script, so it is **more** install
    than A, not less.
  - Page ↔ extension: Chromium supports `externally_connectable` (the page calls `chrome.runtime.sendMessage(extId)`).
    Firefox does not, so it needs a content script and `window.postMessage`. Two code paths.
  - Store review: Chrome Web Store and AMO, each release.
  - Benefit: no listening port and no LNA prompt.
- **B2. The extension itself is the bridge** (a WebSocket to a relay, or to a local port). Its background context is
  not subject to the page's mixed-content rules, and with host permissions for `http://127.0.0.1/*` it can bypass
  LNA. It still needs a local process for Claude Code, unless combined with D.
- Verdict: B is worth it only if LNA prompts or corporate policies block A in practice. Safari would need a separate
  Xcode-packaged extension. Defer to v3, and only on evidence.

**C. Downloadable local version.** The helper serves the UI at `http://localhost:8140`. That page is same-origin with
its API: no LNA, no mixed content, works in Safari, offline, identical to today.

| | |
|---|---|
| Packaging | `npx <pkg>` (needs Node 20+). For people without Node, later: a **Node SEA** single executable (~90 MB per OS); or Electron (Chromium everywhere, ~150 MB, exact parity, auto-update); or Tauri (~10 MB, but the OS WebView: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux, so behaviour differs) |
| Signing | Windows SmartScreen and macOS Gatekeeper want signed binaries (Apple Developer Program: annual fee). `npx` avoids all of that for the Claude Code audience, who already live in a terminal |
| Verdict | C is A's helper opening its own URL. Build A and C at the same time; packaging is v3 |

**D. Remote MCP through a relay (Cloudflare Worker + Durable Object rooms).**
- Claude Code connects by URL: `claude mcp add --transport http workbench https://relay.azemar.eu/mcp`. OAuth is
  supported for remote servers, or a bearer header can be used (`--header "Authorization: Bearer …"`).
- The page opens a WebSocket to the same room. Tool calls go from Claude Code to the Worker, then the Durable Object,
  then the page, which runs `core/ops.js` on its Storage, and back.
- Durable Objects (SQLite-backed) are on the Workers Free plan since Apr 2025. The WebSocket Hibernation API keeps
  idle rooms cheap.

| | |
|---|---|
| Install | Zero local install. Works in Safari, on mobile, and from another machine than Claude Code's |
| What you lose | The page must be open for any tool to work. Generated files are on Claude Code's disk, not in the browser: every output would have to be uploaded through the relay into OPFS. Workable for stills, clumsy for GBs of video. Snapshots and ops run in the page, which is fine |
| Security / privacy | Project text (tool arguments and results) transits Dani's Worker in plaintext over TLS. It cannot be end-to-end encrypted, because Claude Code speaks plain MCP to the relay. It is not stored, but Dani becomes a processor: privacy policy, abuse limits, uptime. A leaked room token lets someone inject text into the director's session (prompt injection) or read the project |
| Verdict | A good v3 add-on for "Claude Code on my server, UI on my laptop/phone". Not the primary |

**Also noted.**
- **Claude Code channels** (research preview since 2026-03-20, Claude Code 2.1.80+). An MCP server that declares the
  `claude/channel` capability can **push** events into a running session. Our helper could forward "Ask Claude"
  messages, note mentions and approval clicks from the page straight into the director's session. This is a new
  faculty, not a replacement. Custom channels need `--dangerously-load-development-channels` until they are
  allow-listed, so ship it as opt-in v3.
- **Claude in Chrome** (the agent driving the browser) can click the UI, but it is no data path. Not used.

### 3.2 Recommendation

- **Primary: A plus C**, the same helper.
  - Hosted page on Chromium/Firefox: pair with the helper and accept the LNA prompt once.
  - Safari, or anyone who prefers it: open `http://localhost:8140` from the helper.
  - Users without the helper: browser storage only, no agent.
- **Fallback without a port: A0** on Chromium. The folder is granted to the page and the MCP server runs in files
  mode. Live updates by polling; `ui_focus` reports "no page channel".
- **v3 options:** D (relay) for remote and mobile; B (extension) only if A's prompts prove to be a real obstacle;
  channels for page → session messages.

### 3.3 One-command setup (target UX)

```
claude mcp add workbench -- npx -y ai-videoclip-director mcp --dir ~/videoclips
```

1. On first start, the MCP process starts the helper on `127.0.0.1:8140`, creates `~/videoclips/` (workspace:
   `projects/`, `workbench.config.json`) and generates a pairing code.
2. In Claude: *"open the workbench"*. The `status` tool returns
   `https://director.azemar.eu/#pair=8140.K7QF-M2XD` (the fragment never reaches Cloudflare) and the local URL
   `http://localhost:8140/` as an alternative.
3. The page reads the fragment, removes it from the URL (`history.replaceState`) and calls the helper.
4. Chrome or Firefox shows the local-network prompt. Once allowed, the page `POST`s `/api/pair {code}` and gets a
   token.
5. From then on the page reconnects silently. The token is in IndexedDB; the helper keeps its hash in
   `~/.config/ai-videoclip-director/tokens.json`.

### 3.4 What the agent may and may not do

The helper enforces these by **who is calling** (the transport and the token's role), never by a field the caller
sends:

| Action | Page token (director) | MCP stdio (agent) |
|---|---|---|
| Read everything in the workspace (except files outside it) | yes | yes |
| Notes, script, shots, entities, media_add, request_create, snapshots | yes | yes |
| `approve`, `request_changes`, request `draft → approved` | yes | **no**. Today the agent can pass `director_approved:true` when the director said so in chat. Replace that with `approve_request(id)` → a confirm dialog in the page ("Claude asks to approve r12, est. $1.20: Approve / Deny"). Only the director's click approves. If no page is open: refused |
| Raise `cap_usd` | yes | no (propose with a note) |
| `request_update` queued/running/done (spending) | n/a | only approved requests, under the cap (today's rules) |
| Delete projects, restore snapshots | yes (confirm) | restore yes (it auto-snapshots); delete no |
| `ui_focus` | n/a | yes (it only moves the view) |
| Read private files | yes, locally | yes (it is the user's own machine). Private files are never exported, zipped or relayed |

### 3.5 Pairing and auth design (helper)

- **Bind:** `127.0.0.1` only, never `0.0.0.0`.
- **Pairing code:** 8 characters from a 31-character unambiguous alphabet, single use, expires after 10 minutes. It
  is only shown to the user (in Claude's `status` output and the helper's stderr). 5 wrong attempts invalidate it.
- **Token:** 256-bit random. The helper keeps a SHA-256 hash. It carries a role (`director`), an origin binding (the
  `Origin` it was issued to) and an optional expiry (default: none, revocable in Settings > Connections and with
  `npx … tokens revoke`).
- **Every request:**
  - `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (defeats DNS rebinding).
  - `Origin` ∈ {`https://director.azemar.eu`, `http://localhost:<port>`, `http://127.0.0.1:<port>`, plus the
    `--allow-origin` list for self-hosters}, and must match the token's origin.
  - `Authorization: Bearer` is required on `/api/*` except `/api/pair` and `/api/status` (which reveals only
    `{app, version, paired:false}`).
  - JSON content type is required.
- **CORS:** answer preflights only for allowed origins. Send `Access-Control-Allow-Private-Network: true` for older
  Chromium. Media responses carry `Cross-Origin-Resource-Policy: cross-origin` only for allowed origins.
- **Same-origin mode (C):** an `HttpOnly; SameSite=Strict` cookie set by a first-run click-through page on localhost
  replaces the header token.
- **Audit:** every write appends `{at, role, op, project}` to `workspace/.workbench/audit.log`, shown in Settings.

## 4. Hosting on azemar.eu

- **Subdomain, not a path:** `director.azemar.eu` (or `videoclip.azemar.eu`; Dani picks). Why:
  - storage, FSA grants, the LNA permission and the pairing token are per origin, and sharing `azemar.eu` with the
    main site would mix quotas and let any script on the main site read users' projects;
  - a strict CSP can be set without touching the main site;
  - it follows the existing pattern (familia, catmap, festacat…).
  - Add `azemar.eu/director → https://director.azemar.eu/ 301` in `web\dani_webpage\public\_redirects`.
- **Platform:** a Cloudflare Pages project `director-azemar`, the same as Dani's other sites (`azemar-web` skill
  flow). Cloudflare now recommends Workers with static assets for new projects and Pages is in maintenance mode
  (2026), but Pages is fully supported and both honour `_headers` / `_redirects`. If the relay (D) is built, it is a
  separate Worker (`relay.azemar.eu`) with a Durable Object, deployed with wrangler.
- **Build step:** `node tools/build-static.mjs`, about 80 lines, no bundler. It:
  - copies an **allow-list**: `index.html`, `dock.html`, `app.*`, `core/`, `js/`, `tabs/`, `sw.js`,
    `vendor/fflate*.js`, `data/demo/`, `data/_template/`, `README.md`, `LICENSE`, `docs/`, `about.html`,
    `privacy.html`;
  - writes `version.json` `{version, commit, built}` from `package.json` and `git rev-parse`;
  - fails if anything matches `workbench.config.json`, `.env`, `private/`, `priv_` or `data/` other than
    demo/_template.
  - Deploy: `npx wrangler pages deploy dist --project-name director-azemar --branch main`. Later, from GitHub
    Actions on a tag, using a scoped API token secret.
- **Headers** (`dist/_headers`):

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
/*.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
```

  - `'unsafe-inline'` in `style-src` is needed for the 9 inline `style=` attributes and the storyboard's
    `document.write` (CSP is inherited by the about:blank window). Removing them later allows a strict policy.
  - **No COEP.** It is only needed for `SharedArrayBuffer` / ffmpeg.wasm-mt, which we do not ship, and it would
    block media from the helper.
  - `connect-src` adds `https://relay.azemar.eu wss://relay.azemar.eu` only if D ships.
- **Help menu:**
  - `help.source` "Source on GitHub" opens `https://github.com/dazca/ai-videoclip-director`.
  - `help.issue` "Report a problem" opens a new issue with the version and browser prefilled. No project data.
  - `help.readme` points at the bundled `README.md` (or the GitHub page).
  - `help.about` becomes a dialog: version, commit (linked), build date, active backend, licence (MIT), third-party
    notices (fflate MIT, Mediabunny MPL-2.0; demo assets CC0, generated by `tools/make_demo.mjs`), and links to the
    privacy page and the source.
  - `about.html` and `privacy.html` are plain pages for people arriving from outside.
- **Versioning:** semver in `package.json`, shared by the npm helper and the site.
  - The page fetches `/api/status` from the helper and warns if the major versions differ ("update the helper:
    `npx -y ai-videoclip-director@latest`").
  - The helper serves its own copy of the UI for C, so a local version always matches its helper.
  - Every Pages deployment keeps an immutable `<hash>.director-azemar.pages.dev` URL, which can be linked from GitHub
    releases.
  - The Service Worker uses a versioned cache name and shows "new version, reload" instead of swapping code under an
    open project.
- **Analytics:** none by default. If Dani wants numbers, Cloudflare Web Analytics is cookieless and needs a script
  tag plus CSP additions. Keep it off unless asked.

## 5. What else a public tool needs

- **Onboarding.**
  - The first screen (no project) offers four choices:
    - "Try the demo" (read-only, instant);
    - "New project from a song" (audio file + lyrics `.lrc`/`.txt`, title, bpm/offset with tap-tempo, cost cap);
    - "Open a folder" (FSA) / "Import a zip";
    - "Connect Claude Code" (shows the one-line `claude mcp add`, and the pairing state).
  - A 6-step coach mark tour of the Timeline (keys 1-4, `?`, Ctrl+K).
- **Sample project.** `data/demo/` (20 s, CC0) is fine for mechanics. Add one richer CC-licensed sample, about 60 s
  with 6 shots, 3 characters with looks and a few requests in every state, so Assets and Review are not empty.
  Never Dani's production (its refs are private).
- **Docs.** `docs/` for the site:
  - getting started for each mode;
  - "connect Claude Code";
  - the file formats (from README);
  - "bring your own generation keys";
  - FAQ (where is my data, Safari, backups);
  - troubleshooting (LNA prompt denied → `chrome://settings/content/localNetworkAccess`; port busy; token revoked).
- **Error handling.**
  - Today a failed save is a 3-second toast. It needs a persistent "unsaved changes" state with retry.
  - Quota errors (`QuotaExceededError`) need a message pointing to zip export.
  - A permission loss (FSA revoked) needs a "Grant access again" banner.
  - Helper disconnect needs a red badge and a read-only switch.
  - A corrupt JSON file needs "open the last snapshot?".
  - `boot()`'s "could not load data" `<pre>` becomes a real screen.
- **Accessibility.** It is keyboard-first already (commands, F10 menu bar, palette). Missing:
  - ARIA roles on menus, menubar, dialogs and tabs;
  - visible focus;
  - contrast of `--dim` text;
  - `aria-hidden` on canvas lanes, with the text columns as the accessible equivalent;
  - `prefers-reduced-motion` for the dock and karaoke;
  - a font-size setting (the 11 px UI is dense by design).
- **i18n (English, Catalan, Spanish).**
  - Extract strings into `i18n/{en,ca,es}.json` with a `t(key)` helper. Most strings are command titles in
    `core/defaults.js` and `core/partb.js`, menu labels, tab names and toasts.
  - Locale from `navigator.languages` with a setting.
  - Keep ids and data English; times and numbers through `Intl`.
  - About 3-5 days including translation review.
- **Mobile.**
  - FSA does not exist there, and the dense 3 px column UI is a desktop tool.
  - Phones get a **Review mode**: Approvals, Queue, Notes, the preview dock full screen, on OPFS or the relay (D).
    That is the one mobile use that makes sense: the director approves from a phone.
  - Otherwise show "best on a desktop browser" and let the timeline scroll (pinch-zoom already works).
- **Tests in CI** (GitHub Actions, Ubuntu):
  - `npm ci`, then `npm run test:mcp`, then `npm run verify` with Chromium from `npx playwright install chromium`
    (CHROME_PATH);
  - new tests:
    - Storage conformance suite run against each backend (OPFS in headless Chromium, helper over HTTP, FSA through
      Chromium's test hooks or OPFS as a stand-in);
    - the zip round trip;
    - the pairing and auth tests: wrong Origin, wrong Host, no token, `text/plain` POST, all 4xx;
    - build-static allow-list test;
  - the Firefox smoke test via Playwright Firefox (OPFS mode);
  - deploy job on tags.
- **Licences of bundled assets.**
  - Repo MIT. Demo CC0 (generated).
  - No web fonts (system fonts only).
  - fflate MIT, Mediabunny MPL-2.0 (file-level copyleft, fine when unmodified and noticed).
  - The HyperFrames player is not in the web build (the exporter vendors it into the user's own package at export
    time from their composition).
  - Add a `THIRD_PARTY.md` and show it in About.
- **Generation side (fal, Suno, etc.).**
  - The page never calls paid APIs. Keys are never in the page, never on azemar.eu, never in the relay.
  - They live where the agent runs: the user's shell environment, `~/.config/<tool>`, or Claude Code's own settings
    (`env` in `.claude/settings.local.json`, gitignored).
  - The workbench only records requests, approvals and the actual cost reported by the agent.
  - Settings shows a read-only "Providers" panel: which tools the agent reported using, totals from `costs.json`. No
    key fields.
  - Document per-provider setup in `docs/generation.md`.
- **Privacy policy** (`privacy.html`, short, Catalan, Spanish, English):
  - static site, no cookies, no analytics;
  - projects stay in your browser or folder;
  - Cloudflare hosts the site and logs requests like any host;
  - the helper listens only on your machine;
  - the relay (if you use it) passes your project text through our server in memory without storing it;
  - your agent and AI providers receive what you send them under their own terms;
  - contact `dani@azemar.eu`.
- **Licence and contribution files for the public repo.** `CONTRIBUTING.md`, issue templates, a `SECURITY.md` with
  the pairing model and how to report.

## 6. Phased plan

Effort is in focused working days (Dani plus agents), including tests.

**v0: hosted read-only demo (2-3 days).**
- `tools/build-static.mjs`, `_headers`, Pages project and DNS for `director.azemar.eu`, `_redirects` on the main site.
- The page in "static" mode: the demo opens without errors, saves are disabled with a clear "demo, read-only" badge.
  In-memory edits are allowed and say so.
- Help > Source on GitHub, About dialog, privacy and about pages, `version.json`.
- Done when: the demo plays, all four pages work, no 404s in the console, Lighthouse a11y ≥ 85, and the build fails
  if a private path sneaks in.

**v1: browser storage plus zip (10-14 days).**
- Fix the helper security hole first (section 1), even before the helper is public.
- `core/storage/` interface, plus OPFS, FSA, IDB-meta and Static backends. Service Worker for `data/` URLs with Range.
- `core/ops.js` extracted from `lib/store.mjs`. Node adapter, so MCP and the server are unchanged in behaviour.
- Projects and snapshots on Storage. Browser thumbnails and strips. New project from a song in the page (the
  `new_project.mjs` port).
- Zip export and import (fflate streaming, private excluded). Storage settings: quota, `persist()`, last backup,
  Safari warning.
- Onboarding screen, error states, i18n scaffold with English plus Catalan/Spanish for onboarding.
- CI with conformance tests on OPFS.
- Done when: a Firefox user and a Chrome user can each create a project from a song, add notes and approvals, take
  and restore snapshots, export a zip, import it in the other browser, and see the same project.

**v2: Claude Code connection (7-10 days).**
- npm package `ai-videoclip-director` with `bin`: `mcp` (stdio, starts or attaches to the helper), `serve`, `tokens`.
- The helper serves the UI too (C).
- Pairing, tokens, Origin/Host/CORS checks, `targetAddressSpace` fetches, LNA-denied guidance.
- `HelperStorage`. SSE through fetch streams. `ui_focus` and ack over it.
- Approval by page confirmation (`approve_request` → dialog), replacing `director_approved:true`.
- A0 files mode documented and tested (FSA + `--offline`).
- Done when:
  - from a clean machine, `claude mcp add …` plus one click on the pairing link gives the hosted page live updates
    from agent tool calls;
  - `ui_focus` moves the page;
  - the agent cannot approve or raise the cap;
  - Safari works through `http://localhost:8140`;
  - `npm run test:mcp`, `verify` and the auth tests pass in CI.

**v3: options, built on evidence (pick from).**
- Channels bridge ("Ask Claude" from the page into the session), behind the development flag until allow-listed:
  3-4 days.
- Relay (D) on Cloudflare Worker + Durable Object, with pairing codes, room tokens, rate limits, privacy text, and the
  mobile Review mode: 8-12 days.
- Desktop packaging (Node SEA binaries per OS via GitHub Releases, or Electron), with code signing: 4-8 days, plus
  certificate cost and time.
- Browser extension (Chromium MV3 with `externally_connectable` + Firefox MV3 with a content-script bridge, native
  messaging host + installer, store submissions): 8-12 days. Only if LNA prompts or enterprise policies block v2 in
  practice.
- Full i18n pass, the richer sample project, docs site polish: 4-6 days.

### Faculties we have today, and how each survives

Columns:
- **Static:** v0 demo.
- **Browser:** v1, OPFS/FSA, no agent.
- **Folder+A0:** FSA plus the agent in files mode.
- **Helper:** v2 A/C, hosted or localhost.
- **Relay:** v3 D.

| Faculty | Static | Browser | Folder+A0 | Helper | Relay |
|---|---|---|---|---|---|
| Warped synced timeline, columns, playback, preview dock, pop-out window | ✓ | ✓ | ✓ | ✓ | ✓ |
| Commands, menus, palette, keybindings (per project), undo/redo | ✓ (in memory) | ✓ | ✓ | ✓ | ✓ |
| Shared files with rev + conflict merge | n/a | ✓ (between tabs) | ✓ (read-compare-write) | ✓ (unchanged) | ✓ (page is the writer) |
| Live reload when the agent writes | n/a | n/a | ✓ (observer / 1.5 s poll) | ✓ (SSE) | ✓ (WS) |
| Projects new / duplicate / delete / recent | demo only | ✓ | ✓ | ✓ | ✓ |
| Snapshots save / restore (auto-snapshot first) | ✗ | ✓ | ✓ | ✓ | ✓ |
| New project from song + lyrics | ✗ | ✓ (in page) | ✓ | ✓ (CLI and page) | ✓ |
| Media index, thumbnails, hover strips | demo's | ✓ (canvas/WebCodecs) | ✓ | ✓ (ffmpeg) | ✓ (page) |
| Media roots outside the project | ✗ | FSA extra grants / OPFS copies | ✓ (grants) | ✓ | uploads only |
| Private files never leave the machine; scrubbed exports | ✓ | ✓ | ✓ | ✓ (+ token) | ✓ (never relayed; tools return "private") |
| Exports: bundle, CSV, storyboard | ✓ | ✓ + zip | ✓ + zip | ✓ + zip | ✓ |
| HyperFrames HTML package export | ✗ | ✗ | via the agent's CLI | ✓ (CLI through the helper or agent) | ✗ |
| 24 MCP tools, resources, director-session prompt | ✗ | ✗ | ✓ (files mode) | ✓ | ✓ |
| Rules: no self-approval, cost cap, `done` needs outputs and cost | n/a | page enforces | ops enforce (raw file edits bypass them) | ✓, plus page-confirmed approvals | ✓ (page runs the ops) |
| `ui_focus` with ack | ✗ | ✗ | ✗ | ✓ | ✓ |
| Agent works while the page is closed | ✗ | ✗ | ✓ | ✓ | ✗ |
| Open file location (Explorer) | ✗ | ✗ (copy path) | ✗ (copy path) | ✓ | ✗ |
| Headless verify + MCP e2e tests | CI | CI | CI | CI | CI |
| Works in Safari | ✓ | ✓ (OPFS; 7-day ITP caveat) | ✗ | ✓ (localhost URL) | ✓ |

The helper column keeps every faculty we have today, and the browser columns lose only the agent-side ones. That is
why the helper is the primary and browser storage is the zero-install entry.

## Sources (checked 2026-10-04)

- Chrome Local Network Access (prompt in Chrome 142, mixed-content exemption, `targetAddressSpace`): https://developer.chrome.com/blog/local-network-access
- LNA for WebSockets from Chrome 147 (secondary source): https://localtonet.com/blog/chrome-local-network-access-apis-websockets
- Firefox LNA policy (Firefox 145+): https://firefox-admin-docs.mozilla.org/reference/policies/localnetworkaccess/ and https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox (149 with ETP Strict, rollout from 151)
- WebKit treats loopback as mixed content (open): https://bugs.webkit.org/show_bug.cgi?id=171934
- File System Access persistent permissions (Chrome 122): https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api
- `showDirectoryPicker` support and the `webkitdirectory` fallback: https://web.dev/articles/files/open-a-directory
- FileSystemObserver: https://developer.chrome.com/blog/file-system-observer and https://developer.mozilla.org/docs/Web/API/FileSystemObserver
- Storage quotas and eviction (MDN, 2026-01-05): https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- WebCodecs support in 2026: https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready
- ffmpeg.wasm single-thread vs multithread: https://github.com/ffmpegwasm/ffmpeg.wasm/issues/337
- Chrome `externally_connectable`: https://developer.chrome.com/docs/extensions/mv3/manifest/externally_connectable ; Firefox lacks it: https://discourse.mozilla.org/t/send-a-message-from-my-website-to-my-extension-background-page/22361
- Claude Code channels (research preview): https://code.claude.com/docs/en/channels-reference.md
- Claude Code remote MCP over HTTP: https://zuplo.com/docs/mcp-gateway/connect-clients/claude-code.md
- Durable Objects on the Workers Free plan, hibernation: https://developers.cloudflare.com/durable-objects/platform/pricing
- Pages vs Workers static assets in 2026: https://mecanik.dev/en/posts/cloudflare-pages-vs-workers-which-to-use-in-2026/

## Owner decision (2026-10-04): the site only serves the app

Dani: "I want to store the minimum things in my webpage, it will just serve the service. Maybe in the future we will
have 'common characters' or something like that, but for now, we try to offload the maximum things onto user. If you
feel appropriate, maybe this 'service' will more like be a webUI executed from local folder of the user. But if we
can make it a service it would make things way faster and easier."

Consequences for every phase above:
- azemar.eu hosts only static files (HTML, JS, CSS, fonts, the demo project). No accounts, no database, no user
  uploads, no analytics, no server-side API, no keys. Nothing a user creates ever reaches our host.
- All user data lives on the user's side: a folder they grant (Chromium), browser-private storage (OPFS) elsewhere,
  zip export/import for backups and moving between browsers, or the local helper's folder.
- Claude Code talks to the user's own local helper (`npx ai-videoclip-director mcp`), never to our site. The relay
  option (Cloudflare Worker + Durable Object) is out of scope unless Dani changes this decision; if it ever comes back
  it must be end-to-end opaque (pairing-code rooms that only forward messages, store nothing).
- The same build runs from the user's own folder (`npx ai-videoclip-director` serves the identical UI on localhost),
  so "hosted service" and "local web UI" are one codebase, two ways to open it. Hosted = fastest to try; local = full
  agent integration and folder access in every browser.
- Future shared content (e.g. "common characters") would be a separate, opt-in, read-only static catalogue
  published like the app itself (no per-user storage).
