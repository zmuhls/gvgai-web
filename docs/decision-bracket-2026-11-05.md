# Jev, CLEF and DeepSeek: November 5 pilot

DeepSeek V4 Flash won the three-model pilot bracket. Jev was substantially
faster, but did not solve the hard games that troubled the older champion.
The arcade keeps CLEF as its default and adds Jev 1.14 as an explicit choice.

## Protocol

The decision was whether a faster model also improves play. The entrants were
Cloudflare CLEF, TypeSafe Jev 1.14 (resolved release `20261014`), and DeepSeek
V4 Flash, the recorded July 10 champion. Every entrant used identical original
game files, engine-verified seeds, simulator evidence, legal choices and guarded
holds of at most six ticks. Provider order rotated between scenarios.

CLEF and Jev used OpenRouter's native Decisions API, pinned to Cloudflare and
TypeSafe respectively. DeepSeek used JSON chat output through Relace, with
reasoning disabled and the same state and action question. Its old tournament
prompt/controller was not reused. No generated code, fabricated probabilities,
retries or provider fallbacks were used. All 604 returned choices in the two
rounds matched their executed actions and hold limits; no provider errors occurred.

Qualifying match points compare each pair on each game. An engine win ranks
above unfinished play, which ranks above a loss. Next comes the score within
that game; completed wins with equal scores compare engine ticks. Remaining
ties split a point. Scores are never summed across different games, and latency
never breaks a gameplay tie. Invalid runs cannot advance. These are development
cases, not a hidden benchmark; one run per configuration cannot establish general
model superiority. All levels below use the arcade's numbering (1–5).

## Bracket

| Qualifier | CLEF | Jev | DeepSeek |
|---|---|---|---|
| Pac-Man, level 1, seed 7, 24 decisions | Capped, score 38 | Capped, score 38 | Capped, score 38 |
| Modality, level 1, seed 2026, 20 decisions | Win, tick 5 | Win, tick 5 | Win, tick 5 |
| Crossfire, level 1, seed 7, 48 decisions | Win, tick 63 | Win, tick 37 | Win, tick 43 |
| Pairwise points | 2 | **4** | **3** |

Jev and DeepSeek advanced to three different games.

| Final | Jev | DeepSeek | Match result |
|---|---|---|---|
| Sokoban, level 5, seed 2026, 16 decisions | Win, score 2, tick 7 | Win, score 2, tick 7 | Draw |
| Butterflies, level 5, seed 7, 48 decisions | Capped, score 10 | Win, score 14 | DeepSeek |
| Zelda, level 5, seed 2026, 48 decisions | Win, score 2 | Win, score 4 | DeepSeek |
| Match points | **0.5** | **2.5** | **DeepSeek wins pilot** |

Across its bracket runs, Jev's median model latency was 243 ms, DeepSeek's
514 ms and CLEF's 571 ms. Their final scenario sets differ, so use the paired
Pac-Man comparison for end-to-end pacing: the same score 38 took 12.2 seconds
with Jev, 21.4 seconds with DeepSeek and 21.6 seconds with CLEF.
The bracket cost $0.097115.

## Targeted hard-game challenge

The user then requested games DeepSeek struggles with. The July 10 record names
DigDug as its only failed qualification. Pac-Man was unfinished for all three
in this pilot; Aliens had no recorded win in the old final. This deliberately
targeted round stays separate from the bracket.

| Challenge | Decision cap | CLEF | Jev | DeepSeek |
|---|---:|---|---|---|
| DigDug, level 2, seed 7 | 32 | Capped, score 4 | Capped, score 5 | Capped, score 6 |
| DigDug, level 5, seed 2026 | 24 | Capped, score 0 | Capped, score 0 | Capped, score 0 |
| Pac-Man, level 5, seed 2026 | 20 | Loss, score 10 | Loss, score 11 | Loss, score 10 |
| Aliens, level 5, seed 7 | 20 | Capped, score 12 | Capped, score 4 | Capped, score 9 |

There were **zero wins, three losses and nine capped runs**. A capped run is
unfinished, not a win or loss. DeepSeek earned 4.5 pairwise points, Jev 4 and
CLEF 3.5, but these progress scores do not imply any model solved a hard case.
Median provider latency was 231.5 ms for Jev, 500 ms for DeepSeek and 560 ms
for CLEF. This round cost $0.096397. Together the 27 episodes cost $0.193511,
within the existing authorized testing allowance.

## Playback change

The supplied Pac-Man trace contained 27 model decisions averaging 779 ms.
Guarded movement produced short bursts followed by model waits. The walk-up
viewer now spaces real received frames using the observed decision cadence,
with at most 12 queued frames and a 1.2-second age limit. Human play remains
immediate. A new run invalidates old image decoding, and completed runs show
the newest frame immediately. Exported traces include frame-gap and backlog
measurements. No movement or intermediate image is invented.

Replaying an earlier captured production stream through a virtual 60 Hz viewer
reduced gaps over 500 ms from 21 to 9, with at most 1,181 ms added delay and
eight stale frames discarded. This is a replay measurement, not live user
acceptance. A local browser run with a scripted 800 ms provider delay rendered
successfully without console errors. Single-step decisions still pause for
inference; buffering cannot create missing engine steps.

## Reproduction and evidence

The runner requires a server-only `CLEF_OPENROUTER_API_KEY`, verifies the
remaining key allowance, reserves each request's maximum cost, validates the
serving model/provider and saves raw inputs, responses, source hashes, effective
seeds and engine summaries. Every invocation requires a fresh output directory.

```sh
node web/scripts/run-decision-bracket.js --out output/new-bracket --budget-usd 0.20
node web/scripts/run-decision-bracket.js --challenge --out output/new-challenge --budget-usd 0.12
```

Local receipts are in `output/arcade-jev-2026-11-05/`. These invocations are
examples, not authorization for additional spending. The web suite and arcade
dry run validate integration; the engine outcomes above validate the bounded
pilot only. No Java game physics or original game files changed.

Current API references: [TypeSafe model versions](https://docs.typesafe.ai/models),
[OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request),
and [DeepSeek V4 Flash providers](https://openrouter.ai/deepseek/deepseek-v4-flash).
