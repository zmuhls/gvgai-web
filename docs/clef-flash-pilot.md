# Clef-flash gameplay pilot

Decision: can the Cloudflare decision model control actual GVGAI games through
the existing Java/Node bridge, with correctly attributed actions and bounded calls?
This is an integration pilot, not a comparative model ranking or production release.

The predeclared pilot uses Sokoban (87) and Aliens (0), level 0, seed 42, with
60 model decisions and 180 seconds maximum per run. Each runs in synchronous
mode (the socket waits for each decision) and asynchronous mode (the ordinary
game loop continues between model decisions). These modes are separate results.
Synchronous mode does not establish compliance with a 40 ms real-time budget.

The model receives rules, the current map, history, and legal choices. Encoded
policies are bypassed for Clef. The default objective prioritizes winning while
avoiding death and irreversible dead ends. There is no model-provider fallback.
Normal asynchronous movement pulses and loop-breaking controls remain active.

Integrity checks: legal typed answers, no hidden provider substitution, at least
one successful decision per game, explicit provider errors and discarded responses.
Report score, actual winner, ticks, calls, token usage, latency p50/p95, and whether
the game ended naturally or hit a cap. Capped runs are not counted as natural losses.
Decision probabilities are not probabilities of winning. Strategy-adherence scores
based on generated prose do not apply to this model.

Credentials are server-only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
The token needs Workers AI permission. The adapter does not read local Wrangler
credentials; an operator can provide a short-lived token through the environment.

From the repository root, with credentials already in the environment:

```sh
GVGAI_JAVAC_BIN=/opt/homebrew/opt/openjdk@11/bin/javac node web/scripts/prepare-java-runtime.js
GVGAI_JAVA_BIN=/opt/homebrew/opt/openjdk@11/bin/java node web/scripts/run-clef-eval.js --max-actions 60 --out output/clef-pilot
```

The runner writes per-run JSON plus a summary, including the code hashes and
each typed decision. It isolates telemetry, traces, and usage counters from
production. With `--max-actions 60`, it permits at most 248 remote attempts across four runs.
The existing production guardrails and default model are unchanged.

The model entry is selectable when credentials are configured. Deployment and
production credential setup are separate from these local pilot runs.

## Results: 2026-10-19 UTC

The integration worked against the CUNY AI Lab Enterprise account using real
headless Java GVGAI games. The win-first objective was retained. The pilot made
206 Cloudflare requests with zero HTTP or response-validation errors, reporting
150,087 input tokens. There was no alternate model provider. Two valid answers
arrived after their runs ended and were discarded; 204 decisions were accepted.

| Game | Mode | Score | Engine tick | Decisions | Outcome | Request p50 / p95 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Sokoban | Step-by-step | 0 | 60 | 60 | Decision cap, unfinished | 387 / 791 ms |
| Aliens | Step-by-step | 7 | 60 | 60 | Decision cap, unfinished | 437 / 996 ms |
| Sokoban | Asynchronous | 0 | 1008 | 60 | Decision cap, unfinished | 456 / 820 ms |
| Aliens | Asynchronous | 17 | 392 | 24 | Natural loss | 457 / 699 ms |

All runs used level 0 and engine seed 42. Fixed engine seeds do not make remote
model decisions or asynchronous network timing deterministic. No run won.
Sokoban repeatedly revisited positions without scoring. This demonstrates a
working integration, not effective general game playing or competitive latency.

The asynchronous controller contributed substantial behavior. Sokoban executed
880 pulse waits, 58 loop-breaking overrides and 70 last-action/default responses.
Aliens executed 257 pulse waits, 14 loop-breaking overrides and 122
last-action/default responses. The receipt label `fallback` refers to this
controller behavior, not a model-provider substitution. Thus these asynchronous
outcomes measure Clef with the existing controller, not the model alone.

Each raw receipt includes the exact typed request and response, probabilities,
token usage, sent engine actions and source attribution. The final engine tick
is an index, so it need not equal the count of sent actions (Aliens sent 393).
Probabilities express the model's action preference; they are not calibrated
win probabilities. No model-authored rationale is fabricated.

Local evidence:

- [Summary and source hashes](../output/clef-pilot-2026-10-19/summary.json)
- [Sokoban step-by-step](../output/clef-pilot-2026-10-19/sokoban-sync-seed42.json)
- [Aliens step-by-step](../output/clef-pilot-2026-10-19/aliens-sync-seed42.json)
- [Sokoban asynchronous](../output/clef-pilot-2026-10-19/sokoban-async-seed42.json)
- [Aliens asynchronous](../output/clef-pilot-2026-10-19/aliens-async-seed42.json)

These receipts are local artifacts under the ignored `output/` directory.
A separate five-decision smoke run preceded the pilot: ten successful requests,
with scores 0 (Sokoban) and 1 (Aliens). Its observations used pixel coordinates;
the pilot's structured position fields use grid coordinates.

Validation: all 347 Java sources compiled; 461 web tests passed and four database
integration tests were skipped; the arcade dry-run planned its 180 cases; the
diff passed whitespace checks. Tests cover native routing, strict legal-action
distributions, timeouts, shared call limits, stale-response rejection, distinct
sprite identities, and final-state capture at the decision cap. Runtime Java
sources and game definitions matched the working source used for the pilot.

Changes are in the local `codex/clef-flash` worktree. No production deployment or
persistent production credential configuration was performed. To repeat the
pilot after building Java and providing server credentials, use
`npm --prefix web run eval:clef -- --max-actions 60 --out output/clef-new-run` from the repository root.
The runner's current default is 300 decisions; see the [extended follow-up](clef-flash-extended.md).
