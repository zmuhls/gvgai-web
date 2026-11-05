# Interactive game pacing

November 5, 2026.

The production Pac-Man trace advanced about once every 2.8 seconds. Model calls
took roughly 0.8 seconds; the Java beam search consumed much of the remaining
time. Pac-Man moves half a tile per tick, amplifying the visible delay. A local
five-observation measurement found about 1.6 seconds of planning per Pac-Man
tick, with roughly 3,400 simulator advances each time.

Interactive play now gives each candidate action a 20 ms beam-search slice,
after seven required immediate-risk samples. Depth, width and operation limits
still apply. The model explicitly chooses a key whose description allows up to
six ticks of movement or firing. Each intervening tick receives a real Java
observation and seven new immediate-risk simulations for every legal action.

A hold never changes the chosen key. It stops for a predicted loss, damage,
blocked or unexpected movement, a moving sprite within three tiles, a newly
available perpendicular turn, changed resources or avatar type, or a changed
player tactic. Java can then return deeper evidence for the same tick without
inserting a waiting action. Sokoban remains single-step and retains its verified
push-space search. Game files, speeds, scores and win conditions are unchanged.

The browser shows the maximum hold and its progress. Its latency display includes
planning plus the model call; the tooltip separates those components. Model
decisions and executed control ticks have separate fields in run receipts.

## Checks before deployment

- Java 11: full compilation of 352 sources.
- 44 live/guard engine cases: all 11 public cabinets, original levels 0 and 4,
  seeds 7 and 2026. Every legal action is covered, required risk samples remain,
  and forecasting preserves the live state.
- Web: 491 passed, four database-dependent skips, zero failures.
- Arcade planning dry run passed.
- A real Java/socket timing test uses a **scripted 800 ms provider**, with six
  requests per run. This measures transport and controller pacing, not CLEF's
  playing strength. It also verifies same-tick replanning, bounded holds, and
  the selected key on every executed tick.

| Game | Previous ticks/sec | Live ticks/sec | Speed ratio |
| --- | ---: | ---: | ---: |
| Pac-Man | 0.42 | 4.31 | 10.3x |
| Aliens | 1.00 | 4.99 | 5.0x |
| Butterflies | 0.84 | 1.43 | 1.7x |

These short checks use level 0 and seed 7. Nearby dynamic sprites deliberately
shorten holds, so the improvement depends on the scene. Interactive play still
pauses for a remote decision when one is needed; this is not a claim of continuous
60 fps play or improved win rate. The earlier 40-case win matrix used the offline
single-step controller, whose default remains unchanged.

Reproduce without provider spending:

```sh
npm --prefix web run java:prepare
java -cp web/.gvgai-runtime/classes:web/.gvgai-runtime/source/gson-2.6.2.jar testing.TestLivePlanning
node web/scripts/check-live-pacing.js /tmp/gvgai-pacing.json
npm --prefix web test
npm --prefix web run eval:arcade
```

Local raw timing logs and subsequent deployment receipts are under
`output/arcade-pacing-2026-11-05/`.
