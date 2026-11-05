# CLEF decision control for GVGAI

## Research and acceptance contract — November 4, 2026

The October pilot connected successfully but won none of eight Aliens/Sokoban
episodes. Increasing the budget did not fix Sokoban's first irreversible push or
the stale-action problem in asynchronous play. The implementation here builds on
that preserved pilot, rather than treating API success as gameplay success.

Primary sources checked:

- [Cloudflare CLEF API](https://developers.cloudflare.com/workers-ai/models/clef/):
  use typed `choice` questions over explicit options and validate probabilities.
  State can be structured JSON. This is not a chat-completion endpoint.
- [Cloudflare's CLEF model card](https://huggingface.co/Cloudflare/clef): the model
  evaluates state and questions in a forward pass, without generating a rationale.
- [Cloudflare's October update](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/):
  hosted CLEF and CLEF-flash have different latency/context tradeoffs. The current
  hosted Flash context is 24,576 tokens; the earlier 64K announcement is outdated.
  Published classification results do not establish GVGAI competence.
- [GVGAI upstream](https://github.com/GAIGResearch/GVGAI) and the local
  `StateObservation.copy()/advance()` implementation: the planning track exposes a
  simulator. Simulated stochastic events need not match the live environment.
- [GVGAI-LLM](https://arxiv.org/html/2508.08501v1): spatial grounding, symbolic
  identity, and planning failures remain despite improved prompting. Track actual
  wins, meaningful progress, and efficiency separately.
- [Spatial reasoning in LLM game agents](https://arxiv.org/html/2607.22732v1):
  causal context and planning help on the paper's focused benchmark, but dynamic
  games require replanning when observations change. These are not CLEF results.

Design inference from this evidence: synchronize remote decisions with engine
steps, provide explicit coordinates and sprite identities, and let CLEF compare
bounded simulated consequences for every legal action. Replan after every real
step. This is a hybrid simulator-assisted agent, not an unassisted model or a
claim to meet the competition's 40 ms budget. Never silently substitute another
provider or count an unfinished run as a win.

Acceptance requires real Cloudflare decisions, legal actions, no provider errors,
and the unmodified Java engine's `PLAYER_WINS` outcome in at least five distinct
upstream games. Initial validation targets are hungrybirds (50), camelRace (15),
crossfire (26), butterflies (13), and chase (18), original level 0, seed 42.
Keep unsuccessful attempts and caps in the report. Additional seeds and games
measure robustness; they do not erase failed attempts. Sokoban remains a specific
regression for irreversible pushes.

## What changed and why

The decision model is full `@cf/cloudflare/clef` by default; Flash remains an
explicit alternative. The request uses a single typed choice question, the
original VGDL rules, a named sprite map, recent positions/scores, and candidate
outcomes. It excludes saved human traces, generated strategy memory, text-response
contracts, and deterministic steering policies. An optional visitor tactic is
sent as a preference. No prompt tells the model that a heuristic is ground truth.

Each legal first action gets a bounded forward search: depth 12, beam width 16,
at most 800 simulator advances, including seven independently seeded immediate
risk samples. The continuation is optimistic; its utility orders terminal wins,
survival, score gain and traversable distance to targets. The map search respects
wall cells. Sokoban additionally detects static dead squares by reverse-push
reachability from holes. Dynamic box interactions and long puzzle dependencies
remain outside this approximation.

Predicted immediate losses and static Sokoban deadlocks are omitted when at least
two alternatives remain. Otherwise all legal options are retained with warnings.
The model still selects the action. Seven samples cannot prove safety, and
deduplicating visible simulator states can discard timing-dependent futures.
Only the first action is executed; forecasts are rebuilt from the next real
observation. Java integration checks verify that forecasting does not mutate the
live observation.

The server rejects model-identity mismatches, illegal choices, malformed
distributions, and choices inconsistent with the returned maximum probability.
Requests have deadlines and a 64 KB application body limit. Failure ends the run;
there is no silent fallback, invented action, or repeated stale action. Session
epochs, level changes and strategy revisions invalidate obsolete responses.
Usage caps count failed attempts as well as successful calls.

The browser selects the configured CLEF model, shows action preferences and
expandable simulator evidence, and stops after the selected level. Percentages
are explicitly labelled as preferences rather than win probabilities. Planning
mode generates normal game frames. The idle autoplay overlay stays out of setup
and play, and unavailable providers no longer fill the model picker.

## Recorded acceptance run

The [machine-readable receipt](clef-acceptance-2026-11-04.json) records the complete
eight-game suite, its source hashes, outcomes, budgets, latency and token usage.
All used full CLEF, original level 0 (shown as Level 1 in the browser), seed 42,
no player tactic, and a cap of 250 decisions per game. The suite finished on
November 4, 2026 at 20:11:53 UTC. Its requirement was at least five distinct wins.

| Game | Result | Score | CLEF decisions | API latency p50 / p95 |
| --- | --- | ---: | ---: | ---: |
| Labyrinth (58) | Win | 1 | 36 | 494 / 716 ms |
| Crossfire (26) | Win | 5 | 39 | 507 / 901 ms |
| Hungry Birds (50) | Win | 100 | 60 | 492 / 860 ms |
| Camel Race (15) | Win | 1 | 45 | 622 / 771 ms |
| Butterflies (13) | Win | 26 | 83 | 587 / 2,510 ms |
| Chase (18) | Win | 7 | 138 | 471 / 774 ms |
| Modality (66) | Win | 1 | 6 | 514 / 1,041 ms |
| Sokoban (87) | Unfinished: decision cap | 3 | 250 | 455 / 770 ms |

**Seven wins, zero API errors, 657 calls and 1,575,258 reported input tokens.**
Every executed action matched that tick's typed CLEF decision; no control-wait or
fallback actions contributed to the wins. API latency excludes Java forecasting
and rendering time. The typed request builder and planner hashes in the receipt
still match the final implementation. Later renderer/startup/UI fixes, including
completion notification when Java closes without a FINISH message, were tested
separately.

This is a verified single-suite result, not an estimate of a general win rate.
Cloudflare decisions and stochastic environments can vary even with the same
game seed. No multi-seed, higher-level, all-game or classroom-concurrency claim
is made. Full CLEF was validated here; the earlier Flash pilot remains historical
evidence, not proof that Flash matches these results.

All intermediate results are retained under
`output/clef-overhaul-2026-11-04/`. The first live attempt exposed the competition
CPU timer disqualifying remote planning. After that fix, the earlier five-game
suite won Camel Race, Butterflies and Chase, capped Hungry Birds, and returned an
HTTP 422 in Crossfire. Route-aware forecasts then won Hungry Birds, while
Crossfire and Chase still lost in stochastic play. The final suite adds the
seven immediate risk samples and records all eight outcomes above. These were
development iterations, not independent benchmark replications.

Exact public requests, typed responses and executed actions are in
`output/clef-overhaul-2026-11-04/acceptance-v4/`. Public VGDL rules and levels were
compared byte-for-byte against the published base revision before each run.
The runner never loads private prompts, saved strategies or human play traces.
Preexisting work is preserved in the adjacent `preexisting/` directory and patch.

To reproduce the bounded acceptance suite after preparing Java and configuring
server-side Cloudflare credentials:

```sh
npm --prefix web run eval:clef -- --games 58,26,50,15,13,18,66,87 \
  --max-actions 250 --require-wins 5 --out output/clef-acceptance-new
```

Use a new output directory each time. A capped run is never converted into a win.

## Integration verification

- Full Java 11 build: 349 sources compiled. Six original-game regressions passed:
  forecasts preserve the live observation, include all legal actions, stay within
  the search budget, and detect Sokoban's initial dead-square push.
- Web suite: 474 tests, 470 passed, four database-dependent tests skipped, zero
  failures. The final run uses `CADAVRE_DB_PATH=:memory:` to isolate server-import
  tests from the running preview; an earlier concurrent run hit a SQLite lock.
- Required arcade dry run: 210 cases planned, no model calls. This does not count
  toward gameplay acceptance.
- A real browser Camel Race run with full CLEF produced 45 decisions and 46 game
  frames, scored 1, showed Victory, and emitted one completed-level notification.
  The browser console had no page errors. Desktop (1440 px) and mobile (390 px)
  setup had no horizontal overflow or autoplay overlay covering the controls.
- A separate mobile run selected Flash, received three real typed decisions and
  stopped successfully. No decision appeared after the stop response during the
  observation window. Late-response unit tests independently cover cancellation.
  This is a Flash integration check, not a Flash game-win claim.

The local preview is a single active-game service. No deployment, multi-user load
test or production acceptance is represented by these checks. The portable
startup instructions require a server-side Workers AI token; validation used
existing operator authentication without writing a token into the repository.
