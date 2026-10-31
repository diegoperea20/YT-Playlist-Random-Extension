# AGENTS.md

Complete guide to this extension for any coding agent (and for humans arriving at the repo).

## What it is

**YT Playlist Random** — browser extension (Chrome/Brave, Manifest V3) for **Chrome/Brave** that shuffles and plays playlists from **YouTube** and **YouTube Music** using **the native YouTube player** (it includes no player of its own). It is a port of the reference web project `yt-playlist-randomizer`.

**Author:** Diego Ivan Perea Montealegre
**Version:** 1.0.0 · **Languages:** ES/EN (automatic i18n according to the browser)

## Architecture at a glance

```
popup.js (UI, polling 1s)  ──chrome.runtime.sendMessage──▶  background.js (service worker MV3)
options.js (Options page) ──────────────▶                    │
                                                               │ chrome.tabs.update → watch?v=<id>
content.js (on youtube.com / music.youtube.com) ◀──────────────┘
   └─ controls the native player: autoplay, pause on 'ended', broken-video detection
```

- **The service worker owns ALL the state.** The UI (popup / options) is a thin layer with no state of its own: it asks for a snapshot (`get-state`), renders and sends commands.
- **Playback is 100% navigation**: to change tracks the tab is navigated to `https://<host>/watch?v=<videoId>` and the YouTube player (inside the page) is the one that plays. Every track change = full page reload. YouTube's internal "next" is never used.
- MV3 kills the worker between events → **all state lives in `chrome.storage`** (never in worker variables).

## Files, one by one

| File | Role |
|---|---|
| `manifest.json` | MV3. Service worker of type **module** (uses `import`). Permissions: `storage`, `tabs`. Host perms: `googleapis.com` (Data API), `*.youtube.com`, `*.ytimg.com`. Content script only on `www.youtube.com` and `music.youtube.com` (excludes `/embed/` and `live_chat`), `run_at: document_idle`. |
| `background.js` | **Service worker (main).** Message router, queue, playback-tab management, storage. See "Message protocol" below. |
| `content.js` | Adapter of the native player inside the YouTube page (anonymous IIFE, marked with `window.__yprContentLoaded`). |
| `popup.js` + `index.html` + `popup.css` | Popup UI: playlists, shuffle modes, queue, ▶/⏸/⏮/⏭ controls, `setInterval(refresh, 1000)` polling. |
| `options.js` + `options.html` | Options page: API key override (empty = bundled key) and playback site (`youtube` / `music`). |
| `lib/api.js` | YouTube Data API v3 directly from the worker: paginated `playlistItems` (50/page, 1 unit/page), durations in batches of 50 (`videos`, 1 unit), title (`playlists`, 1 unit). Maps HTTP errors to internal codes. |
| `lib/shuffle/` | 5 shuffle engines ported 1:1 from the web project (see below). |
| `lib/parseUrl.js` | Extracts `list`/`v` from YT/YT Music URLs. Rejects automatic mixes (`RD…`), "Liked music" (`LL`) and "Watch later" (`WL`) → reason `auto-mix` / `liked-music`. |
| `lib/errors.js` | `YoutubeApiError` — errors by **code** (`error.message` = code), never text. `codeOf(e)` normalizes. The UI translates the code with `chrome.i18n` (`err_<code_with_underscores>`). |
| `lib/time.js` | `parseIsoDuration` (ISO 8601 `PT1H2M3S` → seconds) and `formatTime`. |
| `lib/types.js` | Shared constants: `SHUFFLE_MODES`, `DEFAULT_SETTINGS`, `DEFAULT_SHUFFLE_OPTIONS`. |
| `config.js` | **GENERATED — never edit by hand, never commit** (it is in `.gitignore`). Contains `BUNDLED_API_KEY` with the key from the `.env`. |
| `generate-config.ps1` / `generate-config.sh` | Generate `config.js` reading `YOUTUBE_API_KEY` from the `.env` in the root. `.ps1` = Windows, `.sh` = Linux/macOS (`+x` bit in git index, LF line endings). Both accept the key with/without quotes and inline comments. |
| `_locales/en/messages.json`, `_locales/es/messages.json` | i18n. `default_locale: "en"`. Both files must define the SAME keys (56 each as of the checkpoint) — if you add one in one, add it in the other too, no exceptions. |
| `images/16|32|48|128.png` | Action icons. |
| `.env` | Local only, gitignored: one line `YOUTUBE_API_KEY=...`. |
| `README.md` | User documentation (multi-platform installation, quota, limitations). |
| `PLAN.md` | Port plan (historical). |

## Shuffle engines (`lib/shuffle/`)

Registered in `index.js` (`SHUFFLE_ENGINES`); `generateQueue(mode, playlists, options)` dispatches. All of them use `pools.js::buildPools`, which **always** filters out `available:false` tracks and, with `dedupe:true`, removes cross-playlist duplicates (first winner).

| Mode (settings id) | File | Behavior |
|---|---|---|
| `consecutive-random` (default) | `consecutiveRandom.js` | Alternates between playlists; one track at random without repeating per round; optional `reshuffleRounds` re-shuffles the order of turns on each round. |
| `full-shuffle` | `fullShuffle.js` | Everything in a single pool (`buildPools().flat()` + Fisher-Yates). |
| `proportional` | `proportional.js` | On each turn it yields to the playlist that is furthest behind relative to its size (lowest `consumed/total`), ties broken in playlist order. |
| `sequential-blocks` | `sequentialBlocks.js` | Playlist by playlist, each one shuffled internally. |
| `none` | `sequentialBlocks.js` with `shufflePools:false` | Concatenation in original order (only dedupe/available filter). |

`fisherYates.js::shuffle` **never mutates** the input array (it copies before shuffling); `randomPick` returns `undefined` when empty.

## Message protocol (popup/options/content → background)

Almost everything goes through `chrome.runtime.sendMessage` and responds `{ ok: true, ... }` or `{ ok: false, code }` (code from `YoutubeApiError`/generic). `content.js` also receives commands from the worker: `pause-video`, `resume-video`, `ignore-ended`.

| From | `type` | What it does |
|---|---|---|
| popup/options | `get-state` | Snapshot: `settings` + `playlists` (no tracks; with `trackCount`/`availableCount`) + `queue` + `playback` (+ `tabMissing`). |
| popup/options | `set-settings` | Partial merge (`patch`) over `DEFAULT_SETTINGS`. |
| popup/options | `get-effective-key` | Effective key (`settings.apiKey` \|\| `BUNDLED_API_KEY`) + `missing`. |
| popup | `add-playlist {url}` | Parses URL → loads tracks from the API → saves/updates playlist (upsert by id). |
| popup | `refresh-playlist {id}` | Reloads tracks + renews `loadedAt`. |
| popup | `remove-playlist {id}` | Removes it. |
| popup | `set-playlist-active {id, active, label}` | Shuffler checkbox (+ rename, max 64 chars). |
| popup | `shuffle {andPlay}` | Reloads empty playlists, generates queue with the active mode, resets playback; `andPlay` sets up the tab and navigates to track 1. |
| popup | `set-playing {value}` | `true`: tries **resume in place** (same video already loaded) or ensures tab + navigates. `false`: pauses via content. |
| popup | `next` / `prev` / `jump-to {index}` | Move `queue.index` and navigate to the track. |
| content | `content-ready` | Reports the active tab/video; responds `{ kick, videoId }` if the worker was playing (content.js gives the autoplay push; **the worker never navigates from here** — it would cause a reload loop). |
| content | `play-state {playing, videoId}` | Syncs `playback` with what the player is actually doing. |
| content | `track-ended {videoId}` | Pause already done by content; worker advances the queue (`advanceQueue`). |
| content | `player-error {videoId}` | Marks the track `available:false` in ALL stored playlists, notifies `ignore-ended`, and skips like a normal end of track. |
| content | `yt-navigation {videoId}` | The page changed video without a command (native autoplay or user navigation): worker stops talking to that tab (`lostControl`) until the user presses play. |

## State in `chrome.storage`

| Area | Key | Content |
|---|---|---|
| `local` | `settings` | `{ mode, dedupe, reshuffleRounds, site ('youtube'\|'music'), apiKey (empty = bundled) }` — always merge with `DEFAULT_SETTINGS`. |
| `local` | `playlists` | `[{ id, label, url, tracks: Track[], loadedAt, active }]`. 5 min cache per playlist via `loadedAt` (the UI refreshes with buttons). |
| `session` | `queueState` | `{ queue: Track[], index, mode, generatedAt }`. |
| `session` | `playback` | `{ playing, tabId, videoId }` (+ `lostControl` when YT took over the tab). |

**Track:** `{ id, title, channel, thumbnail, durationSec, playlistId, available }` (see `lib/types.js`).

## Code conventions

- **Plain JavaScript, ES modules, no build, no TypeScript, no dependencies.** Nothing to compile: "Load unpacked" and done.
- Errors by code, never by text (`lib/errors.js` + `_locales`).
- i18n only via `chrome.i18n.getMessage` (helpers `t()` / `ui()`); keys follow the pattern `err_<code>`, `mode_<id_with_underscores>` (+ `_desc`), etc.
- Comments and docstrings mix Spanish/English; the README and user docs go in Spanish.
- To add a shuffle mode: create an engine in `lib/shuffle/`, register it in `SHUFFLE_ENGINES` + `SHUFFLE_MODES`, and add its keys `mode_<id>` and `mode_<id>_desc` in both locales.
- To add a message: case in `background.js::handleMessage` and (if applicable) a listener or dispatcher in `popup.js`/`content.js`.

## Cross-platform setup (generating `config.js`)

```bash
# Windows
powershell -ExecutionPolicy Bypass -File .\generate-config.ps1
# Linux / macOS
bash generate-config.sh        # or ./generate-config.sh (+x bit in the repo)
```

- `.env` **only** in the root of this extension: `YOUTUBE_API_KEY=your-key` (with/without quotes; inline comments allowed).
- `config.js` is a **generated** file: if someone edits it by hand, the key is lost on the next regeneration. Never commit the `.env` or `config.js`.
- After changing `.env`, regenerate. The key can also be changed at runtime from **Options** (`set-settings.apiKey`), which takes priority over the bundled one.

## Quota (important when touching `lib/api.js`)

`playlistItems` = 1 unit/page (50 tracks), `videos` (durations) = 1 unit/batch of 50, `playlists` (title) = 1 unit. Default daily quota: 10,000. Any extra call must be documented in the README.

## Battle-tested gotchas (don't "simplify" without reading this)

1. **`content-ready` must never navigate** from the worker: the freshly loaded page is already on the right track; if the worker navigates again, an infinite reload loop happens. The autoplay kick is given by `content.js`.
2. **Immediate pause on `ended`** (`content.js::attachEnded`): it is the only thing that prevents YouTube's native autoplay from stealing the tab at the end of each video.
3. **Never mark "unavailable" for buffering**: only `playerError` (100/101/150), `.ytp-error` in the DOM, no `<video>` after ~10 s, or hard pause after ~13 s (`content.js::watchForUnavailable`). That's where the thresholds live: 8 s (nudge), 13 s (skip), 10 s (no video) and total watch duration 14 s.
4. **Resume in place**: ▶/⏸ pause of the SAME track does not reload the page (`tryResumeInPlace` compares `playback.videoId` with the current track); changing tracks does navigate.
5. **`yt-navigation` backoff**: if YouTube changed the video without our command, `lostControl` is set and the worker stops talking to that tab until a new `set-playing`.
6. **MV3 lifecycle**: the `chrome.runtime.onMessage` listener **always returns `true`** (async response) and uses asynchronous sendResponse — don't change it to `promise` without verification, the API still requires `true`.
7. **Impossible playlists**: the public API CANNOT read `RD…` (mixes), `LL`/`WL` (liked/watch later) or private ones — `lib/parseUrl.js` rejects them with specific reasons; don't try to "fix" it with more permissions.
8. **Anti-duplicate guards**: the content script runs again after every YouTube SPA navigation. Everything repeatable is protected: `video.dataset.__yprEnded` avoids re-attaching the `ended` listener to the same `<video>`, `reportedErrors` (Set) avoids watching the same videoId twice, `sessionStorage.__yprAutoplayOff` avoids re-clicking the autoplay toggle on every page, and `window.__yprContentLoaded` avoids double init of the whole script. The `MutationObserver` is the one that re-attaches listeners when the DOM changes.

## How to test changes

```bash
# minimal churn for syntax sanity check (optional)
node --check background.js && node --check popup.js && node --check content.js
# (the lib/*.js files use import/export: `node --check` on them requires --input-type=module)
```

Manual loading (there is no pipeline):
1. `brave://extensions` or `chrome://extensions` → **Developer mode** → **Load unpacked** → the repo folder.
2. After changing `.env` or `config.js`: the extension's **Reload** button (content scripts are also renewed by clicking it).
3. YouTube tabs opened before the reload keep the old content script: reload them manually.

## Obvious extension points (for whoever follows)

- New shuffle modes → `lib/shuffle/` + registration in `SHUFFLE_ENGINES`/`SHUFFLE_MODES` + locales (see conventions).
- Persisting the queue across sessions → today it lives in `storage.session` (dies when the browser closes), moving it to `storage.local` is a small change but changes the semantics of `playback.tabId`.
- Tests: there are none; the shuffle engines are pure functions — the best place to start with Vitest would be `lib/shuffle/*` and `lib/parseUrl.js`.
