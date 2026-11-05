# Clef-flash: extended decision allowance

Question: does extending the existing controller from 60 to 300 decisions allow
Clef-flash to win Aliens or Sokoban?

This follow-up keeps the win-first instructions, model, level 0, engine seed 42,
state encoding and controller behavior from the [initial pilot](clef-flash-pilot.md).
Each game runs step-by-step and asynchronously. Only the model-decision allowance
and the wall-clock deadline change. The deadline is now ten minutes per run.
The games' own terminal conditions remain active.

The primary outcome is the Java engine's winner flag. A capped or interrupted
run is unfinished, not a loss. Record score, ticks, accepted decisions, discarded
late responses, actual sent actions, API errors, tokens and latency. The async
controller's waits, repeats and loop-breaking overrides retain separate labels.

Four runs permit at most 1,208 remote attempts. Their counters and receipts stay
in a new local output directory. No production limits or deployment change.
The model's responses and network timing can vary despite the fixed engine seed,
so this small follow-up does not estimate a general win rate.

The runner now defaults to 300 decisions. Reproduce from the repository root
with the Java runtime built and server credentials in the environment:

```sh
npm --prefix web run eval:clef -- --max-actions 300 --out output/clef-extended-new-run
```

## Results: October 19, 2026

No wins in these four runs. All calls used Clef-flash through the lab's
Cloudflare account, with no alternate model provider. There were 750 requests,
zero API or response-validation errors, and 568,988 reported input tokens.
745 responses became decisions; five were discarded as stale.

| Game | Mode | Score | Final tick | Decisions | Outcome | Request p50 / p95 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Sokoban | Step-by-step | 0 | 300 | 300 | Decision cap; unfinished | 421 / 727 ms |
| Aliens | Step-by-step | 37 | 259 | 260 | Avatar killed; loss | 460 / 856 ms |
| Sokoban | Asynchronous | 0 | 2000 | 134 | Engine time limit; loss | 405 / 652 ms |
| Aliens | Asynchronous | 42 | 841 | 51 | Avatar killed; loss | 444 / 727 ms |

Aliens' higher scores did not satisfy its win condition: all spawners and aliens
must be gone while the avatar survives. Its slow spawner creates 20 enemies at
16-tick intervals, so the last spawn occurs around tick 304. A conditional
600-decision follow-up was considered if step-by-step Aliens survived to its
300-decision cap. It died at tick 259, so that follow-up was not run. Both Aliens
episodes ended before using their decision allowance.

The Sokoban step-by-step trace shows an irreversible error on its first move.
At tick 0, `ACTION_UP` pushed the box at grid position (4, 2) to (4, 1). The row
above it is solid wall, so the avatar can never stand above that box to push it
down toward either goal, and neither goal is on row 1. The model then alternated
up/down exactly for the remaining 299 decisions. A larger cap cannot rescue
that state. Future work should address action planning and irreversible pushes.

Asynchronous results include the existing controller's behavior. Sokoban sent
1,723 pulse waits, 132 loop-breaking overrides, and 146 last-action/default
responses. Aliens sent 523 pulse waits, 31 overrides, and 288 last-action/default
responses. These are recorded independently of the model's accepted decisions.
The engine's final tick is an index, not the count of sent actions.

This small fixed-seed follow-up demonstrates that increasing the allowance alone
did not produce a win for the current agent. It does not prove Clef-flash cannot
win with other decisions, seeds, prompts or controller behavior.

Evidence:

- [Summary, source hashes and metrics](../output/clef-extended-2026-10-19/summary.json)
- [Sokoban step-by-step trace](../output/clef-extended-2026-10-19/sokoban-sync-seed42.json)
- [Aliens step-by-step trace](../output/clef-extended-2026-10-19/aliens-sync-seed42.json)
- [Sokoban asynchronous trace](../output/clef-extended-2026-10-19/sokoban-async-seed42.json)
- [Aliens asynchronous trace](../output/clef-extended-2026-10-19/aliens-async-seed42.json)
- [Local validation](../output/clef-extended-2026-10-19/validation.json)

The only changed executable source from the original pilot is the evaluation
runner: default/maximum cap 300, a scaled deadline, and incremental summary
receipts. Model instructions, game rules, levels and controller code were
unchanged. The prepared Java runtime matched the recorded source and game files.
The 55 focused regression tests passed, the 180-case arcade planning dry-run
completed, and syntax and whitespace checks passed. Receipts remain local;
no production deployment or limit change was made.
