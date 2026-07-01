# Prompt Dashboard - Kanban

## Backlog

(empty - all tasks moved to Done)

## TODO

(empty)

## In Progress

(none)

## Done

- [x] **DATA: Seed templates + directory structure** - Created `web/data/templates/` and `web/data/games/`, wrote `_index.json` and 3 default seed templates (system, spatial, constraints)
- [x] **BACKEND: Prompt store module** - Created `web/lib/prompt-store.js` with template CRUD, game config CRUD, `resolveGamePromptConfig(gameId, levelId)` for runtime assembly
- [x] **BACKEND: Prompts API route** - Created `web/routes/prompts.js` with REST endpoints for templates, game configs, and prompt preview
- [x] **CORE: State converter refactor** - Added `buildPrompt(sso, promptConfig)` to `web/lib/state-converter.js` with layered assembly (system + game + progression + tick state) and `{{variable}}` resolution
- [x] **CORE: LLM client integration** - Modified `web/lib/llm-client.js` to accept `gameId`, load prompt config on connect/INIT, use multi-message format (system + user), respect per-game `llmSettings`
- [x] **CORE: Server wiring** - Registered `/api/prompts` route in `web/server.js`, passed `gameId` to LLMClient, added dashboard.js script tag
- [x] **FRONTEND: Dashboard HTML structure** - Added nav tabs (Play/Prompts) to header, created two-column dashboard layout with game list sidebar and editor panel in `index.html`
- [x] **FRONTEND: Dashboard JavaScript** - Created `web/public/js/dashboard.js` with game/template list rendering, editor forms, save/preview logic, API integration
- [x] **FRONTEND: Dashboard CSS** - Added nav tab styles, dashboard grid layout, editor panel, layer badges, prompt preview block to `styles.css`

## Verification Checklist

- [x] All modules load without errors (node -e require test)
- [x] Prompt assembly pipeline produces correct layered output (system + user messages)
- [x] Game config save + resolve works with {{variable}} substitution
- [x] Default fallback works when no game config exists
- [ ] Template CRUD via API works in browser (create, read, update, delete)
- [ ] Game config CRUD via API works in browser
- [ ] `POST /api/prompts/preview` returns assembled multi-layer prompt in browser
- [ ] Game with custom config shows assembled prompt in `llm-reasoning` events
- [ ] Game with NO config falls back to defaults (backward compat)
- [ ] Dashboard UI: navigate, select game, edit templates, save, preview
- [ ] End-to-end: configure assemblyline with strategy template, run game, verify contextual prompts in reasoning log

## Coordination Notes

The other Claude Code instance should:
1. Create game-specific strategy templates in `web/data/templates/` as JSON files following the schema in the plan
2. Create per-game configs in `web/data/games/{gameId}.json` referencing those templates
3. NOT modify `state-converter.js` or `llm-client.js` directly - strategy content goes in JSON template files
4. Use `{{variable}}` syntax for dynamic substitution in template content
