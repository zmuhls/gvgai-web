# Repository Guidelines

## Project Structure & Module Organization

GVGAI fork. Treat the Java engine, VGDL game definitions, and `examples/` as upstream framework code. Local product work mainly lives in `web/`.

- `src/`: Java engine, agents, serialization, and GVGAI entry points.
- `examples/`: VGDL games and levels; `examples/all_games_sp.csv` is the single-player index.
- `web/`: Node server, Socket.IO flow, dashboard, model routing, tests, and eval scripts.
- `web/lib/`, `web/routes/`, `web/public/`, `web/data/`: backend modules, API routes, vanilla frontend, and JSON configs.
- `sprites/`, `doc/`, `clients/`, `logs/`, `out/`: assets, docs, client code, runtime logs, and Java build output.

## Build, Test, and Development Commands

Use Java 11 for engine work:

```bash
export PATH="/opt/homebrew/opt/openjdk@11/bin:/usr/bin:$PATH"
export JAVA_HOME="/opt/homebrew/opt/openjdk@11"
/usr/bin/find src -name "*.java" > sources.txt
javac -cp "gson-2.6.2.jar" -d out @sources.txt
java -cp "out:gson-2.6.2.jar:." tracks.singlePlayer.Test
```

Use the web scripts from `web/`:

```bash
npm install
npm run dev          # nodemon on port 3000
npm start            # production
npm test             # node --test
npm run eval:arcade  # dry-run arcade eval
```

On macOS, make sure cloud-backed files are downloaded before full builds or evals.

## Coding Style & Naming Conventions

Java follows the existing GVGAI style: PascalCase classes, camelCase methods, and package paths matching `src/`. JavaScript uses CommonJS modules, `const`/`let`, two-space indentation, and camelCase functions. JSON data uses two-space formatting. Name game configs by numeric id, for example `web/data/games/0.json`; use kebab-case template ids such as `aliens-strategy`.

## Testing Guidelines

Web tests use Node’s built-in runner in `web/test/*.test.js`; name new files with `.test.js`. For Java changes, run the full compile and the relevant entry point under `src/tracks/**/Test*.java` or `src/testing/`. For prompt or arcade changes, run `npm run eval:arcade` and keep `web/evals/` artifacts only when they are useful evidence.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, for example `add arcade core loop...` or `update readme...`. Keep that style. Pull requests should name the changed layer, list commands run, cite game ids or levels tested, link issues when available, and include screenshots for frontend changes.

## Security & Configuration Tips

Keep secrets in the root `.env`: `OLLAMA_API_KEY` for the primary provider and `OPENROUTER_API_KEY` for fallback. Leave portable paths blank in `web/config.json` when runtime derivation can handle them. Avoid local logs, build output, and absolute machine paths in commits.

## Agent-Specific Instructions

Write plainly. Avoid coined noun phrases, choppy sentence chains, awkward article use, and broad claims detached from files, commands, game ids, or observed behavior.
