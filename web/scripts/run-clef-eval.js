#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { budgetMessage } = require('./clef-eval-budget');

const root = path.resolve(__dirname, '../..');

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const maxActions = Number(option('--max-actions', 300));
  const seed = Number(option('--seed', 42));
  const modes = option('--mode', 'sync').split(',');
  const level = Number(option('--level', 0));
  const games = option('--games', '50,15,26,13,18').split(',').map(Number);
  const model = option('--model', 'clef');
  const requiredWins = Number(option('--require-wins', games.length));
  const captureOnly = args.includes('--capture-only');
  const catalog = fs.readFileSync(path.join(root, 'examples/all_games_sp.csv'), 'utf8').trim().split(/\r?\n/);
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 300 ||
      !Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647 ||
      new Set(modes).size !== modes.length || modes.some(mode => mode !== 'sync') ||
      !Number.isInteger(level) || level < 0 || level > 4 ||
      !['clef', 'clef-flash'].includes(model) ||
      !Number.isInteger(requiredWins) || requiredWins < 0 || requiredWins > games.length ||
      !games.length || new Set(games).size !== games.length || games.some(id => !Number.isInteger(id) || !catalog[id])) {
    throw new Error('Use --max-actions 1..300, --seed integer, --mode sync, --level 0..4, --games distinct CSV ids, --model clef|clef-flash');
  }
  const timeoutMs = Math.max(180000, maxActions * 2000);
  const output = path.resolve(option('--out', path.join(root, 'output', `clef-${Date.now()}`)));
  if (fs.existsSync(output)) throw new Error('Choose a new output directory; evaluation receipts are immutable');
  fs.mkdirSync(output, { recursive: true });
  // Local-only counters and traces. These pilots never configure production
  // telemetry, consume its guardrail state, or load unrelated provider secrets.
  process.env.GVGAI_SEED = String(seed);
  process.env.GVGAI_SOCKET_PORT = String(await freePort());
  process.env.GVGAI_TRACE_DIR = path.join(output, 'traces');
  process.env.GVGAI_SCREENSHOT_PATH = path.join(output, 'frame.png');
  process.env.MODEL_GUARDRAIL_STATE = path.join(output, 'usage-guardrail.json');
  for (const period of ['HOURLY', 'DAILY', 'MONTHLY']) {
    process.env[`MODEL_GUARDRAIL_${period}`] = String(modes.length * games.length * (maxActions + 2));
  }
  process.env.MODEL_GUARDRAIL_SESSION = String(maxActions + 2);
  process.env.TELEMETRY_ENABLED = 'false';
  const telemetry = require('../lib/telemetry-store');
  telemetry.configure({ enabled: false, useEnv: false, flushMs: 0 });
  const { runEvalCase } = require('../lib/batch-evaluator');
  const LLMClient = require('../lib/llm-client');
  const MODEL_ID = `@cf/cloudflare/${model}`;
  const provider = require('../lib/models').resolveModel(MODEL_ID).provider;
  const report = {
    specification: 'clef-gvgai-acceptance-v2', startedAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    model: MODEL_ID, provider, seed, level, games, maxActions, modes, timeoutMs, requiredWins, captureOnly,
    inputPolicy: 'Only committed public VGDL rules and newly simulated engine states; no local templates, human traces, player tactics, or strategy memory.',
    sourceRepository: 'https://github.com/zmuhls/gvgai-web',
    purpose: 'Verify simulator-assisted CLEF choices against original Java engine win conditions.',
    results: []
  };
  const files = ['web/lib/clef-client.js', 'web/lib/llm-client.js', 'web/lib/game-manager.js',
    'web/lib/models.js', 'web/lib/clef-connection.js', 'web/lib/clef-game-config.js', 'web/lib/state-converter.js',
    'web/lib/grid-renderer.js', 'src/tracks/LearningMachine.java', 'src/core/game/SerializableStateObservation.java',
    'web/scripts/prepare-java-runtime.js', 'web/scripts/run-clef-eval.js', 'web/scripts/clef-eval-budget.js',
    'src/tools/ActionLookahead.java', 'src/core/player/LearningPlayer.java', 'src/ontology/Types.java',
    'src/tools/SokobanSearch.java',
    'src/ontology/avatar/MovingAvatar.java', 'src/core/vgdl/VGDLViewer.java',
    'src/tracks/singleLearning/utils/SocketComm.java', 'src/tracks/singleLearning/utils/JavaServer.java',
    'web/lib/batch-evaluator.js',
    'examples/gridphysics/sokoban.txt', 'examples/gridphysics/sokoban_lvl0.txt',
    'examples/gridphysics/aliens.txt', 'examples/gridphysics/aliens_lvl0.txt'];
  report.sourceHashes = Object.fromEntries(files.map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));

  for (const mode of modes) {
    for (const gameId of games) {
      const gameName = path.basename(catalog[gameId].split(',')[1], '.txt');
      const gameFile = catalog[gameId].split(',')[1];
      const publicRules = execFileSync('git', ['show', `HEAD:${gameFile}`], { cwd: root, encoding: 'utf8' });
      for (const file of [gameFile, gameFile.replace('.txt', `_lvl${level}.txt`)]) {
        const committed = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root });
        if (!committed.equals(fs.readFileSync(path.join(root, file)))) throw new Error(`Public source mismatch: ${file}`);
        report.sourceHashes[file] = crypto.createHash('sha256').update(committed).digest('hex');
      }
      const runId = `${gameName}-level${level}-${mode}-seed${seed}`;
      const events = [];
      const attempts = [];
      const engineActions = [];
      let pendingProviderCalls = 0;
      let client;
      const evalCase = { runId, gameId, gameName, levelId: level, modelId: MODEL_ID,
        modelName: model, provider, strategyId: 'default', strategy: '' };
      const start = Date.now();
      let result;
      try {
        result = await runEvalCase(evalCase, {
          timeoutMs, readyTimeoutMs: 60000, expectedSeed:seed,
          io: { emit(event, payload) {
            if (['llm-reasoning', 'model-decision-discarded', 'run-summary', 'llm-error', 'level-end'].includes(event)) {
              events.push({ event, payload });
            }
          } },
          createLLMClient() {
            client = new LLMClient({ runId, initialLevelId: level, maxLevelId: level, stopAfterLevel: true,
              promptConfig: { gameName, gameContent: publicRules },
              synchronousActions: mode === 'sync', maxActions, maxProviderCalls: maxActions + 2,
              actionTimeoutMs: 10000, initResponseType: 'JSON', actResponseType: 'JSON' });
            const observations = new Map();
            const processMessage = client.processMessage.bind(client);
            client.processMessage = async message => {
              const boundary = message.indexOf('#');
              try {
                const sso = JSON.parse(message.slice(boundary + 1));
                if (sso.phase === 'ACT') observations.set(message.slice(0, boundary), sso);
              } catch { /* START and FINISH are control messages, not observations. */ }
              return processMessage(message);
            };
            const send = client.sendMessageWithId.bind(client);
            client.sendMessageWithId = (msgId, message) => {
              const sso = observations.get(String(msgId));
              const action = message.split('#')[0];
              if (sso && action.startsWith('ACTION_') && client.socket && !client.socket.destroyed) {
                const decision = mode === 'sync' ? events.findLast(event =>
                  event.event === 'llm-reasoning' && event.payload.gameState.tick === sso.gameTick) : null;
                engineActions.push({ tick: sso.gameTick, action, scoreBefore: sso.gameScore,
                  positionBefore: sso.avatarPosition,
                  source: mode === 'sync' ? (decision?.payload.decisionSource || 'control-wait')
                    : client.lastDequeuedActionSource });
              }
              observations.delete(String(msgId));
              return send(msgId, message);
            };
            const call = client.callProvider.bind(client);
            client.callProvider = async (...params) => {
              pendingProviderCalls += 1;
              const at = Date.now();
              const attempt = { requestedTick: params[4]?.state?.tick, request: params[4] };
              let reserved = false;
              attempts.push(attempt);
              try {
                if (captureOnly) {
                  fs.writeFileSync(path.join(output, `${runId}-input.json`), JSON.stringify(params[4], null, 2));
                  throw new Error('Capture-only: input saved locally, no external request');
                }
                await budgetMessage('clef-budget:reserve');
                reserved = true;
                const response = await call(...params);
                Object.assign(attempt, { action: response.action, confidence: response.confidence,
                  probabilities: response.probabilities, usage: response.usage, model: response.model,
                  servingProvider:response.raw?.provider });
                return response;
              } catch (error) {
                attempt.error = error.message;
                throw error;
              } finally {
                try {
                  if (reserved) await budgetMessage('clef-budget:settle', attempt.usage?.input_tokens);
                } catch (error) {
                  attempt.error ||= error.message;
                  throw error;
                } finally {
                  attempt.elapsedMs = Date.now() - at;
                  pendingProviderCalls -= 1;
                }
              }
            };
            return client;
          }
        });
      } catch (error) {
        result = { error: error.message, diagnostics: error.diagnostics };
      }
      // Let an in-flight request settle after disconnect. Its epoch is invalid,
      // so the result cannot become a decision in a subsequent game.
      const deadline = Date.now() + 11000;
      while (pendingProviderCalls > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const latencies = attempts.filter(attempt => !attempt.error).map(attempt => attempt.elapsedMs);
      const decisions = events.filter(event => event.event === 'llm-reasoning').map(event => event.payload);
      const summary = events.find(event => event.event === 'run-summary')?.payload || {};
      const receipt = {
        ...evalCase, mode, seed, effectiveSeed:result.engineSeed, seedVerified:result.engineSeed === seed,
        elapsedMs: Date.now() - start, result,
        endedBy: summary.endedBy || (summary.winner === 'PLAYER_WINS' || summary.winner === 'PLAYER_LOSES'
          ? 'game-over' : 'unknown'),
        apiAttempts: attempts.length, apiErrors: attempts.filter(attempt => attempt.error).length,
        modelDecisions: decisions.filter(decision => decision.decisionSource === 'clef-choice').length,
        controlDecisions: decisions.filter(decision => decision.decisionSource !== 'clef-choice').length,
        discarded: events.filter(event => event.event === 'model-decision-discarded').length,
        engineActionCount: engineActions.length,
        actionIntegrity: engineActions.length === decisions.length && engineActions.every(action =>
          decisions.some(decision => decision.gameState.tick === action.tick &&
            decision.action === action.action && decision.provider === provider &&
            decision.modelUsed === MODEL_ID && decision.decisionSource === 'clef-choice')),
        engineActionSources: engineActions.reduce((counts, action) => {
          counts[action.source] = (counts[action.source] || 0) + 1;
          return counts;
        }, {}),
        inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.usage?.input_tokens || 0), 0),
        reportedCostUsd: provider === 'openrouter' ? attempts.reduce((sum, attempt) => sum + (attempt.usage?.cost || 0), 0) : null,
        servingProviders: [...new Set(attempts.map(attempt=>attempt.servingProvider).filter(Boolean))],
        latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
        attempts, engineActions, events
      };
      fs.writeFileSync(path.join(output, `${runId}.json`), JSON.stringify(receipt, null, 2));
      const { attempts: omittedAttempts, events: omittedEvents, engineActions: omittedActions, ...compact } = receipt;
      report.results.push(compact);
      fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
      console.log(`[Clef pilot] ${runId}: ${JSON.stringify({ score: result.finalScore, won: result.won,
        ticks: result.ticks, decisions: receipt.modelDecisions, errors: receipt.apiErrors, latency: receipt.latencyMs })}`);
    }
  }
  report.finishedAt = new Date().toISOString();
  report.successfulGames = report.results.filter(run => run.result.won &&
    !run.apiErrors && !run.result.error && run.modelDecisions > 0 &&
    !run.controlDecisions && run.actionIntegrity && run.endedBy === 'game-over').map(run => run.gameId);
  report.passed = !captureOnly && new Set(report.successfulGames).size >= requiredWins &&
    report.results.every(run => !run.apiErrors && !run.result.error && run.modelDecisions > 0);
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
  console.log(`[Clef pilot] receipts: ${output}`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { percentile };
