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
| `manifest.json` | MV3. Service worker of type **module** (uses `import`). Permissions: `storage`, `tabs`, `alarms` (unavailability watchdog). Host perms: `googleapis.com` (Data API), `*.youtube.com`, `*.ytimg.com`. Content script only on `www.youtube.com` and `music.youtube.com` (excludes `/embed/` and `live_chat`), `run_at: document_idle`. |
| `background.js` | **Service worker (main).** Message router, queue, playback-tab management, storage. See "Message protocol" below. |
| `content.js` | Adapter of the native player inside the YouTube page (anonymous IIFE, marked with `window.__yprContentLoaded`). |
| `popup.js` + `index.html` + `popup.css` | Popup UI: playlists, shuffle modes, queue, ▶/⏸/⏮/⏭ controls, `setInterval(refresh, 1000)` polling. The queue auto-scrolls to the current track (`lastAutoScrollKey` = `generatedAt#index`) only when the position actually moved — never on the 1s re-render, so user scrolling is respected. |
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
| content | `content-ready` | Reports the active tab/video; responds `{ kick, videoId }` if the worker was playing (content.js gives the autoplay push; **the worker never navigates from here** — it would cause a reload loop). `tabId`/`videoId` are FENCED: only the known playback tab, or a page on the queue's current track while no tab is known, may claim the playback role. |
| content | `play-state {playing, videoId}` | Syncs `playback` with what the player is actually doing. FENCED: events from a tab that is not the known playback tab (and not matching the queue's track) are ignored — a random YouTube tab can never re-target the worker. |
| content | `track-ended {videoId}` | Pause already done by content; worker advances the queue (`advanceQueue`). |
| content | `player-error {videoId}` | Marks the track `available:false` in ALL stored playlists, notifies `ignore-ended`, and skips like a normal end of track. |
| content | `yt-navigation {videoId}` | The page changed video without a command (native autoplay or user navigation): worker stops talking to that tab (`lostControl`) until the user presses play. Responds `{ owned: bool }` so content.js binds/releases the media keys. |
| content | `get-media-session` | Asks whether THIS tab belongs to the shuffled queue. Responds `{ owned, queuePlaying }` — `owned` = this is the playback tab on the queue's current track (full ⏭/⏮/⏯ binding); `queuePlaying` = the queue is playing in ITS tab (any idle YouTube tab binds ONLY ⏭/⏮ so a hub media key routed to that tab still reaches the one playback tab). Content decides with a local "is this tab watching something" check. The request carries `videoId` (player-reported): tab URLs go stale after in-place track switches. |
| worker | `play-track {videoId}` | Same-tab track change through the page's own player (`movie_player.loadVideoById`): no navigation, no reload, no tab juggling. The worker uses it whenever the target tab already holds the queue's music; falls back to `navigateToCurrentTrack`'s navigation if the player API is unavailable. |

## State in `chrome.storage`

| Area | Key | Content |
|---|---|---|
| `local` | `settings` | `{ mode, dedupe, reshuffleRounds, site ('youtube'\|'music'), apiKey (empty = bundled) }` — always merge with `DEFAULT_SETTINGS`. |
| `local` | `playlists` | `[{ id, label, url, tracks: Track[], loadedAt, active }]`. 5 min cache per playlist via `loadedAt` (the UI refreshes with buttons). |
| `session` | `queueState` | `{ queue: Track[], index, mode, generatedAt }`. |
| `session` | `playback` | `{ playing, tabId, videoId }` (+ `lostControl` when YT took over the tab; cleared whenever the worker or the user commands playback again). |

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
3. **Never mark "unavailable" for buffering**: only `playerError` (100/101/150), `.ytp-error` in the DOM, no `<video>` after ~10 s, or hard pause after ~13 s (`content.js::watchForUnavailable`). That's where the thresholds live: 8 s (nudge), 13 s (skip), 10 s (no video) and total watch duration 14 s. The watcher survives IN-PLACE track switches: it takes `{ inPlace: true }` from `play-track` (URL never changes there, so identity is the tracked id only) and after in-place-ish calls tolerates a `currentVideoIdNow()` mismatch for a 6 s settle window — aborting on the first tick once stranded the queue forever on a broken video. On the worker side availability is ASSUMED SKIPPED: `advanceQueue` skips every consecutively `available:false` entry, and `set-playing` never resumes a marked-unavailable track (it advances to the first playable one, or ends the queue cleanly if none remains). LAST-RESORT SAFETY NET (`chrome.alarms` watchdog, needs the `alarms` permission): every track the worker COMMANDS arms `pendingVideoId` (`armPendingWatch`) and CONFIRMATION requires REAL TIME PROGRESS (`content.js` throttles `timeupdate` into `play-progress {videoId, currentTime > 1}` — the `play` DOM event is NOT proof: a broken/unlisted video enters the playing state with zero bytes); an unconfirmed track after `PENDING_WATCH_MS` (~25 s, Chrome may clamp alarms to 30 s) is marked unavailable and skipped, and the retry sets `playback.forceNavigation` so the next command does a real RELOAD instead of trusting `loadVideoById` on a player that may be dead after an error state. Teardown pauses poison `playing` (the navigating-away page reports a user pause mid-flight), so `advanceQueue` also navigates whenever the pending command is STALE (`pendingVideoId` set and no longer the current entry — `neverConfirmed`): nobody can pause a track that never played.
4. **Resume in place**: ▶/⏸ pause of the SAME track does not reload the page (`tryResumeInPlace` compares `playback.videoId` with the current track); changing tracks does navigate.
5. **`yt-navigation` backoff**: if YouTube changed the video without our command, `lostControl` is set and the worker stops talking to that tab until a new `set-playing` (also cleared by `navigateToCurrentTrack` and a matching `content-ready`).
6. **MV3 lifecycle**: the `chrome.runtime.onMessage` listener **always returns `true`** (async response) and uses asynchronous sendResponse — don't change it to `promise` without verification, the API still requires `true`.
7. **Impossible playlists**: the public API CANNOT read `RD…` (mixes), `LL`/`WL` (liked/watch later) or private ones — `lib/parseUrl.js` rejects them with specific reasons; don't try to "fix" it with more permissions.
8. **Anti-duplicate guards**: the content script runs again after every YouTube SPA navigation. Everything repeatable is protected: `video.dataset.__yprEnded` avoids re-attaching the `ended` listener to the same `<video>`, `reportedErrors` (Set) avoids watching the same videoId twice, `sessionStorage.__yprAutoplayOff` avoids re-clicking the autoplay toggle on every page, and `window.__yprContentLoaded` avoids double init of the whole script. The `MutationObserver` is the one that re-attaches listeners when the DOM changes.
9. **Media keys**: the Media Session binding is LEVEL-based (`content.js::effectiveMediaLevel`): `full` on the playback tab when the page is on the queue's current track; `next` (ONLY ⏭/⏮) on ANY idle YouTube tab while the queue plays elsewhere — Chrome may route a hub media key to the tab the user is looking at, and the key must reach the ONE playback tab, never spawn a second playing tab; `off` when there is no active queue or the tab is actively playing the user's own video (never hijack it). YouTube re-registers its own handlers at unpredictable moments and the LAST registration wins, so binding once per page is NOT enough: handlers are re-asserted on every `play` event, on every page load, on worker commands and on a 2s interval gated by local flags (the interval never queries the worker by itself). Also FENCE `tabId`/`videoId` in `content-ready`/`play-state` — without the fence, any YouTube tab the user opens claims the playback role and "next" navigates the wrong tab.
10. **Destructure the `ensurePlaybackTab` result**: it returns `{ tab, fresh }`. `prev`/`jump-to` used to grab `const tab = await ensurePlaybackTab(...)` and call `navigateToCurrentTrack(tab.id)` — `undefined` tabId → `holdsOurMusic=false` → a FRESH playback tab on EVERY queue click (the "canción no cambia, abre otra pestaña" bug). Always `const { tab } = ...`; the `[YPR]` console.log lines in the worker are the breadcrumb trail if this ever resurfaces.
11. **Never hijack the visible tab**: `ensurePlaybackTab` only reuses BACKGROUND tabs (`!tab.active`); if the only matching tab is the one the user is looking at, a dedicated `active:false` playback tab is created instead, so a queue click / media key never switches tabs or spawns a second playback. The only place a fresh tab may be RAISED is `shuffle {andPlay: true}` (the user explicitly asked to play). Stale `playback.tabId` must be validated with `chrome.tabs.get` before navigating (`next` does it; `advanceQueue` falls back to `ensurePlaybackTab` when `tabs.update` throws). TRUST ONLY LIVE EVIDENCE (both directions): `playback.tabId` can be POISONED (the user took the old music tab back to browse) — `navigateToCurrentTrack` re-checks with the tab's real URL and, if the tab it is about to navigate is the one the user is WATCHING (foreground) and it no longer holds queue music, it refuses and redirects to another background tab / a dedicated background tab. `pausePlaybackTab` applies the same rule (plus queue-track membership, since in-page switches leave the tab URL stale) before sending `pause-video`. MIRROR RULE: a VISIBLE tab that IS on one of the queue's tracks IS the music tab — `ensurePlaybackTab` claims it (before any fresh-table creation) and the navigation guard lets the in-place navigation happen, so clicking a queue song while looking at the playlist never spawns a second tab. IN-PLACE TRACK CHANGE (preferred): when the target tab already holds the queue's music, `navigateToCurrentTrack` does NOT navigate at all — it sends `play-track {videoId}` and the page's own player (`movie_player.loadVideoById`) switches the track with no reload and no tab juggling; if the content script/player is unavailable it falls back to the navigation path. Tab URLs become STALE after in-page switches — never trust `tab.url`'s `v` for ownership checks; use queue-track membership or `playback.videoId`, and rely on `play-state`/`get-media-session {videoId}` for what is actually playing. FOCUS PRESERVATION: after a real navigation, `navigateToCurrentTrack` re-activates the user's foreground tab/window if the playback tab stole the focus within ~6s (Chrome can raise the navigation target even for a plain background `tabs.update`). A focus change to any OTHER tab is treated as user action and respected.

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
- **LIVE PAGE PROBE (fix for queue clicks opening a new tab)**: tab URLs go STALE after in-place `loadVideoById` switches, so URL-only ownership checks misroute `jump-to`/`next`/`set-playing` to a fresh background tab. `background.js` probes pages via `content.js`'s `get-page-state` ({ videoId, playing } from `currentVideoIdNow()`, never the URL first). `ensurePlaybackTab` resolution order: (1) known `playback.tabId` but VERIFIED by live probe (foreign page video = taken back, fall through), (2) URL pass over BOTH YouTube hosts (`YT_URL_PATTERNS` — never filter by `settings.site`: the user may play on the other flavor), (3) live probe of every YouTube tab (active tabs win), (4) any background YouTube tab, (5) dedicated background tab. `navigateToCurrentTrack` decides the in-place path with the live videoId and navigates on the FINAL target tab's own host (`navHost`), keeping the tab's www/music flavor. Every branch logs `[YPR] tab claimed: …` / `[YPR] play resolve: …` so failures are diagnosable from the service-worker console. URL logic stays as fallback when the content script is unreachable.
- Persisting the queue across sessions → today it lives in `storage.session` (dies when the browser closes), moving it to `storage.local` is a small change but changes the semantics of `playback.tabId`.
- Tests: there are none; the shuffle engines are pure functions — the best place to start with Vitest would be `lib/shuffle/*` and `lib/parseUrl.js`.
