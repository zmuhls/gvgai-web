#!/usr/bin/env node

// Fair head-to-head: every catalog model plays aliens (game 0, level 0)
// with exactly 10 LLM decisions, no strategy prompt, synchronous mode.
// Logs score, winner, per-decision latency, and the action sequence.

const fs = require('fs');
const path = require('path');
const { loadRootEnv } = require('./load-root-env');

async function main() {
  await loadRootEnv();
  const gameManager = require('../lib/game-manager');
  const LLMClient = require('../lib/llm-client');
  const { getAllModels } = require('../lib/models');
  const { getConfig } = require('../lib/runtime-config');
  const config = getConfig();

  const GAME_ID = 0;
  const LEVEL_ID = 0;
  const MAX_ACTIONS = 10;
  const ACTION_TIMEOUT_MS = 15000;
  const READY_TIMEOUT_MS = 30000;
  const RUN_TIMEOUT_MS = 120000;

  // Only test models that can actually run (skip fine-tuned if no local server)
  const allModels = getAllModels().filter(m => !m.finetuned);
  console.log(`\n=== Aliens Head-to-Head ===`);
  console.log(`Game: aliens (id=${GAME_ID}, level=${LEVEL_ID})`);
  console.log(`Max actions per model: ${MAX_ACTIONS}`);
  console.log(`Models: ${allModels.map(m => m.id).join(', ')}\n`);

  const results = [];

  for (const model of allModels) {
    console.log(`\n--- ${model.id} (${model.provider}) ---`);
    let gameProcess = null;
    let llmClient = null;

    try {
      gameProcess = await gameManager.startGame(GAME_ID, LEVEL_ID, false);
      const ready = await gameManager.waitForReady(gameProcess.processId, READY_TIMEOUT_MS);
      if (!ready) {
        const out = gameManager.getProcessOutput(gameProcess.processId);
        console.log(`  FAILED: Java not ready. stderr: ${out.stderr.slice(-200)}`);
        results.push({ modelId: model.id, error: 'java not ready', score: null, actions: [], latencies: [] });
        continue;
      }

      llmClient = new LLMClient({
        initialLevelId: LEVEL_ID,
        synchronousActions: true,
        actionTimeoutMs: ACTION_TIMEOUT_MS,
        maxActions: MAX_ACTIONS,
        initResponseType: 'JSON',
        actResponseType: 'JSON'
      });

      // Collect per-decision telemetry via the io event sink
      const decisions = [];
      llmClient.onSessionEnd = () => {};

      // Override io to capture llm-reasoning events with latency
      const eventSink = {
        emit(event, payload) {
          if (event === 'llm-reasoning' && payload.elapsed != null) {
            decisions.push({
              tick: payload.gameState?.tick || 0,
              action: payload.action,
              reason: payload.reason,
              elapsed: payload.elapsed,
              provider: payload.provider,
              modelUsed: payload.modelUsed
            });
          }
          if (event === 'run-summary') {
            // Store summary on the client for retrieval
            llmClient._finalSummary = payload;
          }
        }
      };

      const summaryPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('run timeout')), RUN_TIMEOUT_MS);
        eventSink.emit = new Proxy(eventSink.emit, {
          apply(target, thisArg, args) {
            const [event, payload] = args;
            if (event === 'run-summary') {
              clearTimeout(timer);
              resolve(payload);
            }
            return Reflect.apply(target, thisArg, args);
          }
        });
      });

      await llmClient.connect(
        config.gvgai.socketPort,
        model.id,
        eventSink,
        GAME_ID,
        'aliens',
        null  // no strategy — no cheating
      );

      const summary = await summaryPromise;

      const latencies = decisions.map(d => d.elapsed);
      const avgLatency = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;
      const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
      const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;

      const result = {
        modelId: model.id,
        provider: model.provider,
        score: summary.finalScore,
        winner: summary.winner,
        won: summary.won,
        ticks: summary.ticks,
        decisions: summary.decisions,
        actions: summary.actions,
        avgLatencyMs: avgLatency,
        minLatencyMs: minLatency,
        maxLatencyMs: maxLatency,
        latencies: latencies,
        decisionDetails: decisions
      };
      results.push(result);

      console.log(`  Score: ${result.score} | Winner: ${result.winner} | Ticks: ${result.ticks}`);
      console.log(`  Actions: ${result.actions.join(', ')}`);
      console.log(`  Latency: avg=${avgLatency}ms min=${minLatency}ms max=${maxLatency}ms`);
      for (const d of decisions) {
        console.log(`    tick ${d.tick}: ${d.action} (${d.elapsed}ms) — ${d.reason}`);
      }

    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
      const out = gameProcess ? gameManager.getProcessOutput(gameProcess.processId) : null;
      if (out) console.log(`  stderr: ${out.stderr.slice(-300)}`);
      results.push({ modelId: model.id, error: error.message, score: null, actions: [], latencies: [] });
    } finally {
      if (llmClient) {
        try { llmClient.disconnect(); } catch {}
      }
      if (gameProcess) {
        await gameManager.stopGameAndWait(gameProcess.processId, 5000);
      }
      // Brief pause to let the socket port free up
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Final scoreboard
  console.log(`\n\n=== SCOREBOARD ===`);
  console.log(`${'Model'.padEnd(22)} ${'Score'.padEnd(7)} ${'Winner'.padEnd(15)} ${'Ticks'.padEnd(7)} ${'Avg ms'.padEnd(8)} ${'Actions'}`);
  console.log('-'.repeat(90));
  const sorted = results
    .filter(r => r.score != null)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const r of sorted) {
    console.log(
      `${r.modelId.padEnd(22)} ${String(r.score).padEnd(7)} ${(r.winner || '?').padEnd(15)} ${String(r.ticks || 0).padEnd(7)} ${String(r.avgLatencyMs || 0).padEnd(8)} ${(r.actions || []).join(',')}`
    );
  }
  const errors = results.filter(r => r.score == null);
  if (errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errors) {
      console.log(`  ${e.modelId}: ${e.error}`);
    }
  }

  // Save full results
  const outPath = path.resolve(__dirname, '..', 'data', 'eval-runs', `head-to-head-aliens-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), gameId: GAME_ID, levelId: LEVEL_ID, maxActions: MAX_ACTIONS, results }, null, 2));
  console.log(`\nFull results: ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});