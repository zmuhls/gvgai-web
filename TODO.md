# TODO — SLM roster, traces, guardrail (2026-07-05)

## Done

- [x] **Import human play traces** — copied `~/Desktop/traces/arcade-trace-aliens-*.json` (3 files) into `web/data/traces/`
- [x] **Human-vs-SLM analysis** — `web/data/traces/human-vs-slm-analysis.md`: human aliens play is 80–89% fire at 2–4 decisions/s with fresh state; SLM path is 400ms-gated stale-state intent; roster notes
- [x] **Model catalog overhaul** (`web/lib/models.js`) — open-weight, non-reasoning, Ollama Cloud-only roster:
  - [x] gemma3:27b (featured, default)
  - [x] qwen3-coder-next (only non-thinking Qwen on Ollama Cloud; ~80B MoE)
  - [x] ministral-3:14b / 8b / 3b, devstral-small-2:24b
  - [x] removed residue big models (gpt-oss:120b, deepseek-v3.1:671b, qwen3-coder:480b), OpenRouter frontier entries (gemini-2.5-flash, gpt-4o, claude-sonnet-4.5), and ollama-local entries
  - [x] OpenRouter fallback slugs verified against /api/v1/models 2026-07-05 (devstral has no unambiguous slug -> fallback null)
  - [x] default model moved in both homes: `web/config.json` `defaultModel` + `featured` flags; stale fallback in `lib/runtime-config.js` updated
  - [x] frontend `PREVIEW_MODELS` fallback list (`web/public/js/app.js`) updated
  - [x] tests updated: `eval-plan.test.js` featured assertions, `llm-client.test.js` model literals
- [x] **Ollama key usage guardrail** — `web/lib/usage-guardrail.js`, light rule-of-thumb caps on ollama-cloud calls:
  - [x] hourly 3000 / daily 15000 / per-session 1500, env-tunable (`OLLAMA_GUARDRAIL_HOURLY/DAILY/SESSION`), `OLLAMA_GUARDRAIL_DISABLED=1` kill switch
  - [x] hour/day buckets persisted to `web/data/usage-guardrail.json` (gitignored)
  - [x] enforced at the single Ollama Cloud request site (`llm-client.js` `callProvider`); a block skips the OpenRouter fallback (no silent spend shift), emits `llm-error`, tracks a `system`/`guardrail_block` telemetry event
  - [x] unit + integration tests in `web/test/usage-guardrail.test.js`

## Deploy

- [x] commit + push — GitHub push-to-deploy connected; all commits pushed to master triggered Railway rebuild
- [x] verify live: `curl https://inference-arcade.com/api/models` shows the 7-model roster
- [x] verify live: `GET /api/telemetry/guardrail` returns counters
- [x] verify live: `POST /api/prompts/preview` assembles prompts

## Follow-ups

- [x] **Human-trace recorder bug** — human decisions now sync live tick/score from the `game-state` socket event (stored in `state.liveGameState`) instead of reading stale DOM text. Export trace nulls the `model` field when `playerType === 'human'` so the recorder no longer stamps the selected model chip on human runs.
- [ ] **Qwen slot** — revisit when Ollama Cloud hosts a small (<=31B) non-thinking Qwen; qwen3-coder-next is the placeholder representative
- [ ] **Devstral fallback** — OpenRouter only lists `mistralai/devstral-2512` (size ambiguous); add a fallback slug if a clear devstral-small appears
- [x] **Guardrail visibility** — guardrail counters (hour/day usage + limits) now surfaced on the telemetry dashboard via GET /api/telemetry/guardrail and a guardrail card with progress bars.
- [x] **Code-protocol games vs gemma3** — disabled `codeProtocol.enabled` on all 5 GV1 games (0, 4, 13, 15, 18) and bumped maxTokens 50→100. These games now use the natural-language 8-layer prompt that gemma3 handles well, instead of the compact GV1 code format the model couldn't parse.

## Inference Arcade UI Checklist

Source scope: pasted task log in `/Users/milwright/.codex/attachments/cc2bc348-675d-426d-bd8a-1833a4620aca/pasted-text-1.txt`, browser comments, and current `web/public` worktree.

- [x] Add a sticky bottom-right autoplay marble player that sits over the home page like a persistent video.
  - Evidence: `web/public/index.html` contains `#marble-popout`, `web/public/js/marble-popout.js` controls expand, close, dwell start, and socket state.

- [x] Make the marble player visually active even before a real backend frame arrives.
  - Evidence: `web/public/js/marquee.js` draws the idle attract animation and exposes `render_game_to_text` and `advanceTime`.

- [x] Keep `/marquee?embed=1` compact for the floating player and use a fuller layout when popped out.
  - Evidence: `web/public/marquee.html` applies `marquee-embed` and `marquee-full` classes from query params.

- [x] Fix `/marquee` as a navigable page, not a dead end.
  - Evidence: `web/public/marquee.html` has `Spectator feed`, `Back`, and `Arcade home` navigation.

- [x] Make mobile marble behavior drawer-like.
  - Evidence: CSS collapses `.marble-popout` to the footer at `max-width: 600px`, JS expands on tap or upward swipe and shrinks on downward swipe.

- [x] Start the universal marble stream after the visitor has been on site for 5 seconds.
  - Evidence: `web/public/js/marble-popout.js` calls `startUniversalMarbleRun('dwell')` after `5000` ms and posts to `/api/marble/start`.

- [x] Make global typography and peripheral labels more legible.
  - Evidence: `web/public/css/styles.css` bumps `.step-label`, `.games-mode-label`, game-card metadata, levels, and button text sizes.

- [x] Prevent the hero subtitle from wrapping on desktop.
  - Evidence: `web/public/css/styles.css` applies `#game-selector .step-note { white-space: nowrap; }` above `760px`.

- [x] Show roughly 15 featured cabinets with pinned first row and randomized cached rows after that.
  - Evidence: `web/public/js/app.js` uses `FEATURED_CABINET_COUNT = 15`, `FEATURED_FIRST_ROW_IDS`, `shuffleGames`, and `state.featuredShowcase`.

- [x] Make `Browse all 122` unfold to the real catalog in static preview.
  - Evidence: `web/public/data/games.json` serves 122 games, and `web/public/js/app.js` falls back to it when `/api/games` returns only the five-card preview stub.

- [x] Make companion room subtitles exact and non-wrapping.
  - Evidence: `web/public/index.html` uses `Fill-in-the-Blank Game Engine` and `Jeopardy! Board Clue Generator`, and CSS keeps `.companion-subtitle` on one line with ellipsis fallback.

- [x] Give companion room cards distinct, customized aesthetics.
  - Evidence: `.room-cloze` uses parchment/brass styling and `.room-jeopardy` uses a modern blue Jeopardy palette in `web/public/css/styles.css`.

- [x] Remove the broken Cloze top-right icon and use a Jeopardy `J` badge.
  - Evidence: `.room-cloze::after { content: none; }` and `.room-jeopardy::after { content: "J"; }`.

- [x] Keep companion URL text readable and non-wrapping.
  - Evidence: `.companion-url` styles use stronger contrast, `white-space: nowrap`, `overflow: hidden`, and `text-overflow: ellipsis`.

- [x] Fix the header brand and GitHub link.
  - Evidence: `web/public/index.html` links `.titlebar-brand` to `https://github.com/zmuhls/gvgai-web`, title is `gvgai-web`, subtitle is `LLM Game Cabinets`.

- [x] Rename the first nav tab to `Java Arcade`.
  - Evidence: `web/public/index.html` nav button text.

- [x] Replace vague `LINK` header text with functional socket state.
  - Evidence: `web/public/js/shell.js` writes `Socket live`, `Socket offline`, or `Socket error`.

- [x] Add a Telemetry component for backend availability and model routing.
  - Evidence: `web/public/index.html` adds `Model Backend Status`, `web/public/js/telemetry-dashboard.js` renders active backend, browser socket, Ollama Cloud, OpenRouter fallback, Local Ollama, and telemetry store cards.

- [x] Replace vague Operator Desk deck copy.
  - Evidence: `web/public/index.html` explains system prompts, game rule digests, progression hints, action aliases, model defaults, and exact prompt preview.

- [x] Run final verification across changed frontend files.
  - Evidence: `node --check` passed for `app.js`, `shell.js`, `marble-popout.js`, `marquee.js`, and `telemetry-dashboard.js`.
  - Evidence: `curl http://localhost:4173/` returns the updated header, Operator Desk copy, companion subtitles, Telemetry backend panel, and marble popout markup.
  - Evidence: `curl http://localhost:4173/css/styles.css` returns the removed Cloze badge, Jeopardy `J` badge, backend grid styles, nowrap rules, and marble popout styles.
  - Evidence: `curl http://localhost:4173/data/games.json` returns 122 games, ids `0` through `121`, no missing ids.
  - Evidence: `npm test` in `web/` passed, 228 tests, 228 passing.
  - Browser note: in-app Browser automation timed out while reading the selected tab URL and Playwright is not installed locally, so final proof is command and served-asset based rather than interactive click-through.
