'use strict';

const traceStore = require('./play-trace-store');

/**
 * Build a compact prompt-layer summary of the best human traces for a game.
 *
 * Returns null when no human traces exist, otherwise an object:
 *   { text, traceCount, bestScore, winRate }
 *
 * The text is kept under ~500 chars and contains:
 *  1. Outcome statistics (plays, best score, win rate)
 *  2. High-scoring action patterns (top 4 most-used actions in the best run)
 *  3. Score-gaining actions (up to 5 reward-signal examples)
 *  4. Common opening moves (if 2+ top traces share the same opening)
 *  5. Death/loss patterns (first ~10 actions of the worst lost trace)
 */
function buildTraceSummary(gameId, options = {}) {
  const stats = traceStore.getTraceStats(gameId);
  if (!stats || stats.humanTraceCount === 0) {
    return null;
  }

  const bestSummaries = traceStore.getBestHumanTraces(gameId, 3);

  // Load full traces for the best runs
  const fullTraces = bestSummaries
    .map(s => traceStore.getTrace(gameId, s.traceId))
    .filter(Boolean);

  if (fullTraces.length === 0) {
    return null;
  }

  const winPct = Math.round(stats.winRate * 100);
  const parts = [];

  // 1. Outcome statistics
  parts.push(
    `Human players have played this game ${stats.humanTraceCount} times. ` +
    `Best score: ${stats.bestScore}. Win rate: ${winPct}%.`
  );

  // 2. High-scoring action patterns from the best run
  const bestFull = fullTraces[0];
  if (bestFull && bestFull.actionHistory && bestFull.actionHistory.length > 0) {
    const counts = {};
    for (const entry of bestFull.actionHistory) {
      const a = entry.action || 'ACTION_NIL';
      counts[a] = (counts[a] || 0) + 1;
    }
    const top4 = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([action, count]) => `${action}(${count})`)
      .join(', ');
    if (top4) {
      parts.push(`Best run actions: ${top4}.`);
    }
  }

  // 3. Score-gaining actions (reward signal)
  if (bestFull && bestFull.scoreEvents && bestFull.scoreEvents.length > 0) {
    const rewards = bestFull.scoreEvents
      .slice(0, 5)
      .map(e => `${e.action || 'ACTION_NIL'} (+${e.scoreDelta})`)
      .join(', ');
    if (rewards) {
      parts.push(`Rewards: ${rewards}.`);
    }
  }

  // 4. Common opening moves — if 2+ top traces share the same first 2-5 actions
  if (fullTraces.length >= 2) {
    const openings = fullTraces
      .map(t => (t.actionHistory || []).slice(0, 5).map(e => e.action || 'ACTION_NIL'));
    // Find the longest common prefix shared by at least 2 traces
    let bestPrefix = null;
    let bestLen = 0;
    const minLen = Math.min(...openings.map(o => o.length), 5);
    for (let len = 5; len >= 2; len--) {
      const freq = {};
      for (const o of openings) {
        const key = o.slice(0, len).join(',');
        if (key && o.length >= len) {
          freq[key] = (freq[key] || 0) + 1;
        }
      }
      for (const [key, count] of Object.entries(freq)) {
        if (count >= 2 && len > bestLen) {
          bestPrefix = key.split(',');
          bestLen = len;
        }
      }
    }
    if (bestPrefix) {
      parts.push(`Common opening: ${bestPrefix.join(', ')}.`);
    }
  }

  // 5. Death/loss patterns — worst-scoring lost trace
  const allHuman = traceStore.getTracesForGame(gameId, { playerType: 'human' });
  const lostTraces = allHuman.filter(t => !t.won);
  if (lostTraces.length > 0) {
    const worstSummary = lostTraces[lostTraces.length - 1]; // lowest score among lost
    const worstFull = traceStore.getTrace(gameId, worstSummary.traceId);
    if (worstFull && worstFull.actionHistory) {
      const avoidActions = worstFull.actionHistory
        .slice(0, 10)
        .map(e => e.action || 'ACTION_NIL')
        .join(', ');
      if (avoidActions) {
        parts.push(`Avoid (lost run): ${avoidActions}.`);
      }
    }
  }

  const text = parts.join(' ');

  return {
    text,
    traceCount: stats.humanTraceCount,
    bestScore: stats.bestScore,
    winRate: stats.winRate
  };
}

module.exports = { buildTraceSummary };