# Sokoban search and expanded validation

November 4, 2026, America/New_York.

## Failure and correction

The earlier full-CLEF run cleared three of four boxes in original Sokoban level 0
but then cycled until its 250-decision cap. Static dead-square checks prevented
an obvious losing push; twelve-step beam forecasts still could not resolve the
remaining sequence of pushes and walking moves.

The original [GVGAI rules](../examples/gridphysics/sokoban.txt) differ from
classic Sokoban: pushing a box into a hole removes the box, and the hole remains
available for subsequent boxes. Level 0 has four boxes and two holes. A
one-box/one-goal matching heuristic would therefore model the wrong problem.

The new search uses push-space weighted A*. Walking paths are computed between
pushes, and reverse-push distances prune static dead squares. The heuristic sums
distances to reusable holes, and completed path suffixes are cached by walls,
holes, boxes, and avatar position. This cache contains newly computed game
states, not a stored solution to a particular level. Each search is bounded by
60,000 expanded nodes, 250 milliseconds, and 300 moves. Weighted search can find
a solution quickly but does not promise the shortest solution. Exhausting a
budget is reported as unknown, never as a proven deadlock.

For every candidate first move, the complete proposed continuation is replayed
in a copy of the Java engine. Only an actual `PLAYER_WINS` outcome can produce
the engine-verified label. CLEF compares the legal candidates and their verified
solution lengths, then selects the action. The executor still sends exactly
the typed CLEF choice; the solver never drives the game directly. Replanning
starts from the next real observation. Other games retain their previous
forecasting method and decision instructions.

The game name comes from the existing game registry, so this specialized search
is enabled only for `sokoban`, not games with superficially similar sprites but
different rules. The public chooser now includes Sokoban and all five levels.

This design uses the distinction between push states and walking moves and the
importance of deadlock detection discussed by
[Junghanns and Schaeffer](https://www.aiinternational.org/Library/AAAI/1998/aaai98-059.php).
It is a small bounded search, not their pattern-search implementation.
[Cloudflare's CLEF API](https://developers.cloudflare.com/workers-ai/models/clef/)
continues to supply typed choices and probability distributions; a verified
simulation is search evidence rather than model-authored reasoning.

## Recorded checks

The machine-readable [receipt](clef-expansion-2026-11-04.json) separates live
model results from engine-only checks and blocked attempts.

- **Sokoban: 15/15 live CLEF wins.** All five unchanged levels, each with seeds
  7, 42, and 2026; 561 decisions, 1,889,868 reported input tokens, no provider
  errors, and every engine action matched that tick's typed model decision.
- Decisions per run by UI level: 91, 31, 26, 31, and 8. Scores: 4, 3, 3, 3, and 2.
  Sokoban is deterministic; repeating seeds checks the integration, not a
  claim of stochastic robustness. The earlier development pilot also won
  level 0 in 91 decisions and is retained separately.
- All 15 abstract solution paths were independently replayed to wins by Java
  integration tests. The original state remained unchanged by search.
- Engine-only expanded checks: 44 cases across 11 games, levels 0/4 and seeds
  7/2026. They verified unchanged observations, bounded forecasts, and coverage
  of every legal action. They do not establish CLEF game wins.
- Full Java 11 compilation: 351 sources. Web: 476 passed, four database-dependent
  skips, zero failures. The required arcade planning dry run passed.

## Broader live matrix and account limit

The fixed matrix contains 55 cases: the 15 Sokoban cases plus Aliens,
Butterflies, Camel Race, Chase, Crossfire, Frogs, Hungry Birds, Labyrinth,
Modality, and Zelda on levels 0/4 with seeds 7/2026. Each case is capped at 300
decisions. Cases use separate Java sockets, screenshots, local usage counters,
and immutable receipts, permitting at most three concurrent cases.

The separate personal Cloudflare account exhausted its daily free AI quota
after Sokoban and 99 further decisions across three Aliens runs. Those three
runs were interrupted, and the remaining games could not start inference.
All 40 non-Sokoban cases are classified as provider errors, not losses or wins.
The initial failed attempts remain in the receipts. The runner now stops
scheduling cases on the first infrastructure error and can resume only failed
or unstarted cases; completed wins, losses and capped runs are retained.

Cloudflare confirmed the account's free daily allocation was exhausted with
HTTP 429. No enterprise account or alternate provider was used to bypass it.
The [published quota and reset policy](https://developers.cloudflare.com/workers-ai/platform/pricing/)
requires paid capacity or the next reset before live testing can continue.
The release does not claim completed multi-game live coverage until those
remaining cases have actual results.

## Reproduce

Configure server-side credentials for the personal account or its dedicated
relay, prepare Java, and use a new output directory:

```sh
npm --prefix web run java:prepare
npm --prefix web run eval:clef:matrix -- --out output/clef-matrix-new
```

After resolving an infrastructure failure, resume into another new directory:

```sh
npm --prefix web run eval:clef:matrix -- \
  --resume-from output/clef-matrix-new/summary.json \
  --out output/clef-matrix-resumed --budget-usd 4.75
```

`--budget-usd` caps the new invocation (default $5), not historical runs. Deduct
earlier spending from the authorized allowance before resuming. The parent
reserves 65,536 input tokens before each child may call CLEF, then charges
reported usage at $0.24 per million input tokens. Missing usage, provider errors,
or a child exiting during a request conservatively consume the full reservation.
Concurrent children share one allowance and stop before an unaffordable request.
The receipt records reported, conservatively charged, and still-reserved tokens.
Prices and maximum context were checked against
[Cloudflare's model documentation](https://developers.cloudflare.com/workers-ai/models/clef/)
on November 4, 2026; recheck them before future evaluations.

Use `--dry-run` to inspect the fixed cases without calling a model. Raw local
receipts, engine actions and provider attempts are retained under
`output/clef-expansion-2026-11-04/`.
