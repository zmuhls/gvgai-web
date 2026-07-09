(function () {
  const socket = window.arcadeSocket;
  const state = {
    snapshot: null,
    models: [],
    refreshTimer: null,
    pendingRefresh: null
  };

  const familyLabels = {
    evaluation: 'Evaluation',
    user_experience: 'UX',
    clickthrough: 'Clickthrough',
    model_telemetry: 'Model',
    trace: 'Trace',
    system: 'System'
  };

  async function loadSummary() {
    try {
      const [summaryRes, guardRes, finetuneRes, modelsRes] = await Promise.all([
        fetch('/api/telemetry/summary?limit=80'),
        fetch('/api/telemetry/guardrail'),
        fetch('/api/finetune/status').catch(() => null),
        fetch('/api/models').catch(() => null)
      ]);
      if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`);
      state.snapshot = await summaryRes.json();
      state.guardrail = guardRes.ok ? await guardRes.json() : null;
      state.finetune = finetuneRes && finetuneRes.ok ? await finetuneRes.json() : null;
      state.models = modelsRes && modelsRes.ok ? await modelsRes.json() : (state.models || []);
      render();
    } catch (error) {
      renderError(error);
    }
  }

  function scheduleRefresh() {
    if (state.pendingRefresh) return;
    state.pendingRefresh = setTimeout(() => {
      state.pendingRefresh = null;
      loadSummary();
    }, 650);
  }

  // Stations B–D are <details> and render lazily: collapsed stations only
  // update their always-visible headline stat; interiors paint on open.
  function stationOpen(id) {
    const node = document.getElementById(id);
    if (!node) return false;
    return node.tagName !== 'DETAILS' || node.open;
  }

  function renderStationStats(snapshot) {
    const outcomes = snapshot.evalOutcomes || {};
    const total = outcomes.total || 0;
    const winPct = total ? Math.round(((outcomes.wins || 0) / total) * 100) : 0;
    setText('station-b-stat', total ? `${formatNumber(total)} · ${winPct}% W` : '—');
    const latency = snapshot.metrics?.averageModelLatencyMs || 0;
    setText('station-c-stat', latency ? `${formatNumber(latency)}ms` : '—');
    setText('station-d-stat', formatNumber(snapshot.metrics?.totalEvents || 0));
  }

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    // Station A (always open) + the collapsed-station headline stats.
    setText('telemetry-storage-status', snapshot.storage?.label || 'unknown');
    setText('telemetry-live-clients', `${snapshot.liveClients || 0} clients`);
    setText('telemetry-fallback-status', sourceLabel(snapshot));
    setText('telemetry-events-rate', formatNumber(snapshot.metrics?.eventsPerMinute || 0));
    renderStationStats(snapshot);
    renderBackendStatus(snapshot);

    if (stationOpen('station-b')) {
      setText('telemetry-leaderboard-source', sourceLabel(snapshot));
      renderEvalChart(snapshot.evalOutcomes || {});
      renderRunLeaderboard((snapshot.leaderboards || {}).runs || []);
      renderMarbleRun(snapshot.marbleRun || {});
    }

    if (stationOpen('station-c')) {
      renderUsageLeaderboard((snapshot.leaderboards || {}).usage || []);
      renderModelChart(snapshot.models || []);
      renderGuardrail(state.guardrail);
    }

    if (stationOpen('station-d')) {
      setText('telemetry-stream-count', `${formatNumber(snapshot.metrics?.totalEvents || 0)} events`);
      setText('telemetry-pipeline-source', pipelineLabel(snapshot.pipeline, snapshot));
      renderPipeline(snapshot.pipeline || {});
      renderFinetune();
      renderFlow(snapshot);
      renderEvents(snapshot.recentEvents || []);
      renderFunnel(snapshot.funnel || {});
      renderTraceChart(snapshot.traceTypes || []);
      renderSessionLeaderboard((snapshot.leaderboards || {}).sessions || []);
    }
  }

  // Marble run controls
  const marbleStartBtn = document.getElementById('marble-start-btn');
  const marbleStopBtn = document.getElementById('marble-stop-btn');
  if (marbleStartBtn) {
    marbleStartBtn.addEventListener('click', async () => {
      marbleStartBtn.disabled = true;
      try {
        await fetch('/api/marble/start', { method: 'POST' });
      } catch (e) { /* best-effort */ }
      marbleStartBtn.disabled = false;
      loadSummary();
    });
  }
  if (marbleStopBtn) {
    marbleStopBtn.addEventListener('click', async () => {
      marbleStopBtn.disabled = true;
      try {
        await fetch('/api/marble/stop', { method: 'POST' });
      } catch (e) { /* best-effort */ }
      marbleStopBtn.disabled = false;
      loadSummary();
    });
  }

  // Fine-tune pipeline panel: fetched status as the base, live socket
  // progress payloads overlaid until the run finishes.
  const finetuneStageLabels = {
    preparing: 'Preparing training data…',
    data_prepared: 'Training data ready',
    training: 'Starting training…',
    start: 'Starting training…',
    load_data: 'Loading dataset…',
    gpu_check: 'Checking GPU…',
    load_model: 'Loading base model…',
    train_begin: 'Training…',
    train_step: 'Training…',
    train_complete: 'Training complete',
    export_gguf: 'Exporting GGUF…',
    registry_written: 'Registering model…',
    done: 'Finishing…',
    loading: 'Loading into Ollama…',
    load_skipped: 'Ollama load skipped',
    model_loaded: 'Model loaded into Ollama',
    complete: 'Pipeline complete',
    shutdown: 'Interrupted by shutdown'
  };

  function renderFinetune() {
    const el = document.getElementById('telemetry-finetune');
    if (!el) return;
    const status = state.finetune;
    const live = state.finetuneLive;
    let run = status?.run || null;
    if (live && (!run || live.runId === run.runId || !run.finishedAt)) {
      run = {
        ...(run || {}),
        ...live,
        progress: live.stage === 'train_step'
          ? { step: live.step, totalSteps: live.totalSteps, loss: live.loss, epoch: live.epoch }
          : (run?.progress || {})
      };
    }

    if (!run || !run.runId) {
      const count = status?.registry?.count || 0;
      el.innerHTML = '<div class="telemetry-empty">No fine-tune runs yet — human plays on featured games feed the pipeline</div>';
      setText('telemetry-finetune-model', count ? `${count} model(s) in registry` : 'no runs yet');
      return;
    }

    const stageLabel = finetuneStageLabels[run.stage] || run.stage || '—';
    const progress = run.progress || {};
    const pct = progress.totalSteps
      ? Math.min(100, Math.round((progress.step / progress.totalSteps) * 100))
      : (run.state === 'complete' ? 100 : 4);
    const tone = run.state === 'failed' ? 'danger' : (run.state === 'complete' ? 'success' : 'accent');

    el.innerHTML = `
      <div class="guardrail-bar finetune-run finetune-tone-${tone}">
        <span>${escapeHtml(run.gameName || `game ${run.gameId}`)} <small>${escapeHtml(run.state || '')}${run.dryRun ? ' · dry run' : ''}</small></span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <strong>${pct}%</strong>
      </div>
      <div class="finetune-stage">
        <span>${escapeHtml(stageLabel)}</span>
        ${progress.loss != null ? `<small>step ${Number(progress.step) || 0}/${Number(progress.totalSteps) || 0} · loss ${(Number(progress.loss) || 0).toFixed(3)}</small>` : ''}
        ${run.error ? `<small class="finetune-error-text">${escapeHtml(run.error.code || 'error')}: ${escapeHtml(run.error.message || '')}</small>` : ''}
      </div>
    `;
    setText('telemetry-finetune-model',
      run.modelId || (run.state === 'failed' ? 'run failed' : 'run in progress'));
  }

  function renderBackendStatus(snapshot) {
    const grid = document.getElementById('telemetry-backend-grid');
    const activeEl = document.getElementById('telemetry-backend-active');
    if (!grid) return;

    const activeBackend = (document.getElementById('backend-label')?.textContent || 'unknown').trim();
    const selectedModel = selectedModelLabel();
    const models = Array.isArray(state.models) ? state.models : [];
    const providerCounts = models.reduce((counts, model) => {
      const provider = model.provider || 'unknown';
      counts[provider] = (counts[provider] || 0) + 1;
      return counts;
    }, {});
    const fallbackCount = models.filter(model => model.fallback || model.provider === 'openrouter').length;
    const localCount = (providerCounts['ollama-local'] || 0) + (providerCounts.local || 0);
    const socketLive = Boolean(socket && socket.connected);

    if (activeEl) activeEl.textContent = activeBackend;

    const cards = [
      {
        label: 'Active backend',
        value: activeBackend || 'unselected',
        detail: selectedModel || 'selected when a model is chosen',
        state: activeBackend && activeBackend !== 'unknown' ? 'online' : 'warn'
      },
      {
        label: 'Browser socket',
        value: socketLive ? 'online' : 'offline',
        detail: 'streams frames, traces, and run summaries',
        state: socketLive ? 'online' : 'offline'
      },
      {
        label: 'Ollama Cloud',
        value: providerCounts['ollama-cloud'] ? `${providerCounts['ollama-cloud']} model(s)` : providerValueFromLabel(activeBackend, 'Ollama Cloud'),
        detail: 'primary hosted open-weight inference',
        state: providerCounts['ollama-cloud'] || activeBackend === 'Ollama Cloud' ? 'online' : 'warn'
      },
      {
        label: 'OpenRouter fallback',
        value: fallbackCount ? `${fallbackCount} route(s)` : providerValueFromLabel(activeBackend, 'OpenRouter'),
        detail: 'backup route when primary calls fail',
        state: fallbackCount || activeBackend === 'OpenRouter' ? 'online' : 'warn'
      },
      {
        label: 'Local Ollama',
        value: localCount ? `${localCount} model(s)` : providerValueFromLabel(activeBackend, 'Local Ollama'),
        detail: 'fine-tuned or local registry models',
        state: localCount || activeBackend === 'Local Ollama' ? 'online' : 'offline'
      },
      {
        label: 'Telemetry store',
        value: sourceLabel(snapshot),
        detail: snapshot.storage?.label || snapshot.storage?.state || 'storage state pending',
        state: snapshot.storage?.state === 'disabled' ? 'warn' : 'online'
      }
    ];

    grid.innerHTML = cards.map(card => `
      <article class="backend-status-card backend-status-${escapeHtml(card.state)}">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.value)}</strong>
        <small>${escapeHtml(card.detail)}</small>
      </article>
    `).join('');
  }

  function providerValueFromLabel(activeBackend, providerLabel) {
    return activeBackend === providerLabel ? 'selected' : 'not listed';
  }

  function selectedModelLabel() {
    const select = document.getElementById('model-select');
    const option = select?.selectedOptions?.[0];
    if (!option) return '';
    return option.textContent.replace(/\s+/g, ' ').trim();
  }

  function renderGuardrail(g) {
    const el = document.getElementById('telemetry-guardrail');
    if (!el) return;
    if (!g || g.disabled) {
      el.innerHTML = '<div class="telemetry-empty">Guardrail disabled</div>';
      return;
    }
    const limits = g.limits || {};
    const hourPct = Math.min(100, Math.round((g.hourCount / limits.hourly) * 100));
    const dayPct = Math.min(100, Math.round((g.dayCount / limits.daily) * 100));
    el.innerHTML = `
      <div class="guardrail-bar">
        <span>Hourly <small>${formatNumber(g.hourCount)} / ${formatNumber(limits.hourly)}</small></span>
        <div class="bar-track"><div class="bar-fill" style="width:${hourPct}%"></div></div>
        <strong>${hourPct}%</strong>
      </div>
      <div class="guardrail-bar">
        <span>Daily <small>${formatNumber(g.dayCount)} / ${formatNumber(limits.daily)}</small></span>
        <div class="bar-track"><div class="bar-fill" style="width:${dayPct}%"></div></div>
        <strong>${dayPct}%</strong>
      </div>
    `;
  }

  // The Tote Board: per-model standings + strategy effect from the marble run.
  function renderMarbleRun(marble) {
    setText('telemetry-marble-total', `${formatNumber(marble.totalCases || 0)} cases`);

    const standings = document.getElementById('telemetry-marble-standings');
    if (standings) {
      const rows = marble.standings || [];
      // Weight-change annotation: fine-tuned rows show their score delta vs
      // the arcade's default (first featured) model, when both have played.
      const catalog = state.models || [];
      const finetunedIds = new Set(catalog.filter(m => m.finetuned).map(m => m.id));
      const baselineModel = catalog.find(m => m.featured);
      const baselineRow = baselineModel ? rows.find(r => r.modelId === baselineModel.id) : null;
      standings.innerHTML = rows.length ? rows.map(row => {
        let weightChange = '';
        if (finetunedIds.has(row.modelId) && baselineRow && baselineRow.modelId !== row.modelId) {
          const delta = Number(row.meanScore) - Number(baselineRow.meanScore);
          weightChange = ` <span class="weight-change ${delta >= 0 ? 'positive' : 'negative'}">` +
            `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs ${escapeHtml(baselineRow.modelId)}</span>`;
        }
        return `
        <div class="bar-row" style="--bar-width: ${Math.max(4, row.winRate)}%;">
          <span>${escapeHtml(row.modelId)} <small>${row.meanScore} avg · ${row.strongAdherenceRate}% adhere · ${row.fallbackRate}% fallback</small>${weightChange}</span>
          <strong>${row.winRate}% W</strong>
        </div>
      `;
      }).join('') : '<div class="telemetry-empty">No marble-run cases yet</div>';
    }

    const strat = document.getElementById('telemetry-marble-strategy');
    if (strat) {
      const rows = marble.byStrategy || [];
      if (!rows.length) {
        strat.innerHTML = '<div class="telemetry-empty">No strategy data yet</div>';
      } else {
        const max = Math.max(1, ...rows.map(row => row.meanScore));
        strat.innerHTML = rows.map(row => `
          <div class="bar-row" style="--bar-width: ${Math.max(4, (row.meanScore / max) * 100)}%;">
            <span>${escapeHtml(row.label)} <small>${row.winRate}% win</small></span>
            <strong>${row.meanScore}</strong>
          </div>
        `).join('');
      }
    }
  }

  function renderRunLeaderboard(rows) {
    const table = document.getElementById('telemetry-run-leaderboard');
    if (!table) return;
    if (rows.length === 0) {
      table.innerHTML = '<div class="telemetry-empty">Waiting for run records</div>';
      return;
    }

    table.innerHTML = `
      <div class="leaderboard-row leaderboard-head">
        <span>#</span>
        <span>Model</span>
        <span>Runs</span>
        <span>W-L</span>
        <span>Best</span>
      </div>
      ${rows.slice(0, 6).map((row, index) => `
        <div class="leaderboard-row">
          <span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span>
          <span>
            <strong>${escapeHtml(row.modelId)}</strong>
            <small>${escapeHtml(compactSet(row.providers) || compactGameSet(row.gameIds) || 'recorded')}</small>
          </span>
          <span>${formatNumber(row.runs)}</span>
          <span>${formatNumber(row.wins)}-${formatNumber(row.losses)}</span>
          <span>${formatNumber(row.bestScore)}</span>
        </div>
      `).join('')}
    `;
  }

  function renderUsageLeaderboard(rows) {
    const table = document.getElementById('telemetry-usage-leaderboard');
    if (!table) return;
    if (rows.length === 0) {
      table.innerHTML = '<div class="telemetry-empty">Waiting for model usage</div>';
      return;
    }

    table.innerHTML = `
      <div class="leaderboard-row usage-head">
        <span>#</span>
        <span>Model</span>
        <span>Calls</span>
        <span>Avg</span>
        <span>Chars</span>
      </div>
      ${rows.slice(0, 6).map((row, index) => `
        <div class="leaderboard-row usage-row">
          <span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span>
          <span>
            <strong>${escapeHtml(row.modelId)}</strong>
            <small>${escapeHtml(compactSet(row.providers) || 'provider pending')}</small>
          </span>
          <span>${formatNumber(row.decisions)}</span>
          <span>${formatNumber(row.averageLatencyMs)}ms</span>
          <span>${formatCompactNumber(row.totalChars)}</span>
        </div>
      `).join('')}
    `;
  }

  function renderSessionLeaderboard(rows) {
    const table = document.getElementById('telemetry-session-leaderboard');
    if (!table) return;
    if (rows.length === 0) {
      table.innerHTML = '<div class="telemetry-empty">Waiting for sessions</div>';
      return;
    }

    table.innerHTML = `
      <div class="leaderboard-row session-head">
        <span>#</span>
        <span>Session</span>
        <span>Events</span>
        <span>Starts</span>
        <span>Seen</span>
      </div>
      ${rows.slice(0, 6).map((row, index) => `
        <div class="leaderboard-row session-row">
          <span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span>
          <span>
            <strong>${escapeHtml(shortId(row.sessionId))}</strong>
            <small>${escapeHtml(compactGameSet(row.gameIds) || compactSet(row.sources) || 'active')}</small>
          </span>
          <span>${formatNumber(row.events)}</span>
          <span>${formatNumber(row.startClicks + row.runSummaries)}</span>
          <span>${escapeHtml(formatTime(row.latestAt))}</span>
        </div>
      `).join('')}
    `;
  }

  function renderPipeline(pipeline) {
    const rail = document.getElementById('telemetry-pipeline');
    if (!rail) return;
    const steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
    if (steps.length === 0) {
      rail.innerHTML = '<div class="telemetry-empty">Waiting for storage state</div>';
      return;
    }

    rail.innerHTML = steps.map((step, index) => `
      <div class="pipeline-step pipeline-${escapeHtml(step.key || 'step')}">
        <span class="pipeline-index">${String(index + 1).padStart(2, '0')}</span>
        <div>
          <span>${escapeHtml(step.label)}</span>
          <strong>${formatNumber(step.value || 0)}</strong>
          <small>${escapeHtml(step.detail || '')}</small>
        </div>
      </div>
    `).join('');
  }

  function renderFlow(snapshot) {
    const container = document.getElementById('telemetry-flow');
    if (!container) return;

    const events = snapshot.recentEvents || [];
    const families = ['evaluation', 'user_experience', 'clickthrough', 'model_telemetry', 'trace'];
    container.innerHTML = families.map(family => {
      const laneEvents = events.filter(event => event.family === family).slice(0, 12);
      const sparks = laneEvents.map((event, index) => `
        <span class="flow-spark family-${escapeHtml(family)}"
          title="${escapeHtml(event.type)}"
          style="--spark-left: ${((index * 17) + 6) % 92}%; --spark-delay: ${index * -0.38}s;"></span>
      `).join('');

      return `
        <div class="flow-lane">
          <span class="flow-label">${escapeHtml(familyLabels[family] || family)}</span>
          <div class="flow-line">${sparks}</div>
          <span class="flow-count">${laneEvents.length}</span>
        </div>
      `;
    }).join('');
  }

  function renderEvents(events) {
    const table = document.getElementById('telemetry-event-table');
    if (!table) return;

    if (events.length === 0) {
      table.innerHTML = '<div class="telemetry-empty">Waiting for events</div>';
      return;
    }

    table.innerHTML = `
      <div class="telemetry-event-row telemetry-event-head">
        <span>Time</span>
        <span>Family</span>
        <span>Type</span>
        <span>Model</span>
        <span>Latency</span>
      </div>
      ${events.slice(0, 18).map(event => `
        <div class="telemetry-event-row">
          <span>${escapeHtml(formatTime(event.at))}</span>
          <span class="event-family family-${escapeHtml(event.family)}">${escapeHtml(familyLabels[event.family] || event.family)}</span>
          <span>${escapeHtml(event.type)}</span>
          <span>${escapeHtml(event.modelId || event.provider || '-')}</span>
          <span>${event.latencyMs == null ? '-' : `${formatNumber(event.latencyMs)}ms`}</span>
        </div>
      `).join('')}
    `;
  }

  function renderEvalChart(outcomes) {
    const chart = document.getElementById('telemetry-eval-chart');
    if (!chart) return;
    const rows = [
      ['Wins', outcomes.wins || 0, 'success'],
      ['Losses', outcomes.losses || 0, 'danger'],
      ['Other', outcomes.other || 0, 'neutral']
    ];
    chart.innerHTML = renderBarRows(rows);
  }

  function renderFunnel(funnel) {
    const chart = document.getElementById('telemetry-funnel-chart');
    if (!chart) return;
    const max = Math.max(1, funnel.gameSelections || 0, funnel.startClicks || 0, funnel.startedRuns || 0, funnel.runSummaries || 0);
    const steps = [
      ['Selections', funnel.gameSelections || 0],
      ['Start clicks', funnel.startClicks || 0],
      ['Runs', funnel.startedRuns || 0],
      ['Summaries', funnel.runSummaries || 0]
    ];
    chart.innerHTML = steps.map(([label, value]) => `
      <div class="funnel-step" style="--bar-width: ${Math.max(4, (value / max) * 100)}%;">
        <span>${escapeHtml(label)}</span>
        <strong>${formatNumber(value)}</strong>
      </div>
    `).join('');
  }

  function renderModelChart(models) {
    const chart = document.getElementById('telemetry-model-chart');
    if (!chart) return;
    if (models.length === 0) {
      chart.innerHTML = '<div class="telemetry-empty">Waiting for model decisions</div>';
      return;
    }
    chart.innerHTML = models.map(model => `
      <div class="model-row">
        <div>
          <strong>${escapeHtml(model.modelId)}</strong>
          <span>${formatNumber(model.decisions)} decisions</span>
        </div>
        <span>${formatNumber(model.averageLatencyMs)}ms</span>
      </div>
    `).join('');
  }

  function renderTraceChart(traceTypes) {
    const chart = document.getElementById('telemetry-trace-chart');
    if (!chart) return;
    const rows = traceTypes.length
      ? traceTypes.map(item => [item.type, item.count, 'accent'])
      : [['No trace yet', 0, 'neutral']];
    chart.innerHTML = renderBarRows(rows);
  }

  function renderBarRows(rows) {
    const max = Math.max(1, ...rows.map(row => row[1]));
    return rows.map(([label, value, tone]) => `
      <div class="bar-row tone-${escapeHtml(tone)}" style="--bar-width: ${Math.max(4, (value / max) * 100)}%;">
        <span>${escapeHtml(label)}</span>
        <strong>${formatNumber(value)}</strong>
      </div>
    `).join('');
  }

  function renderError(error) {
    setText('telemetry-storage-status', error.message || 'summary failed');
  }

  function sourceLabel(snapshot) {
    if (snapshot.storage?.state === 'disabled') return 'disabled';
    if (snapshot.dataSource === 'supabase') return 'supabase rows';
    if (snapshot.dataSource === 'fallback') return 'local fallback';
    if (snapshot.storage?.state === 'connected') return 'memory fallback';
    return 'local memory';
  }

  function pipelineLabel(pipeline, snapshot) {
    if (!pipeline) return sourceLabel(snapshot);
    const state = pipeline.storageState || snapshot.storage?.state || 'unknown';
    const source = pipeline.source || snapshot.dataSource || 'memory';
    return `${sourceLabel({ ...snapshot, dataSource: source })} / ${state}`;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function formatCompactNumber(value) {
    return Number(value || 0).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function shortId(value) {
    const text = String(value || 'session');
    if (text.startsWith('browser-')) return text.slice(0, 18);
    if (text.startsWith('run:')) return text.slice(4, 22);
    return text.length > 20 ? `${text.slice(0, 17)}...` : text;
  }

  function compactSet(values) {
    return Array.isArray(values) ? values.filter(Boolean).slice(0, 2).join(' / ') : '';
  }

  function compactGameSet(values) {
    if (!Array.isArray(values) || values.length === 0) return '';
    return `games ${values.slice(0, 3).join(', ')}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  document.querySelectorAll('#main-nav .nav-link').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.target === 'telemetry-dashboard') {
        loadSummary();
      }
    });
  });

  // Lazy station interiors: paint from the cached snapshot the moment a
  // station opens, instead of waiting for the next poll tick.
  document.querySelectorAll('#telemetry-dashboard details.telemetry-station').forEach(section => {
    section.addEventListener('toggle', () => {
      if (section.open) render();
    });
  });

  // The guided A → B → C → D path: each "Next" link opens the following
  // station before scrolling to it.
  document.querySelectorAll('#telemetry-dashboard .station-next').forEach(link => {
    link.addEventListener('click', event => {
      const target = document.getElementById(link.dataset.stationNext || '');
      if (!target) return;
      event.preventDefault();
      if (target.tagName === 'DETAILS') target.open = true;
      const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      if (history.replaceState) history.replaceState(null, '', `#${target.id}`);
    });
  });

  // Deep links (#station-b/c/d) open their station on load.
  if (/^#station-[b-d]$/.test(window.location.hash)) {
    const target = document.getElementById(window.location.hash.slice(1));
    if (target && target.tagName === 'DETAILS') target.open = true;
  }

  if (socket) {
    socket.on('connect', () => renderBackendStatus(state.snapshot || {}));
    socket.on('disconnect', () => renderBackendStatus(state.snapshot || {}));
    socket.on('connect_error', () => renderBackendStatus(state.snapshot || {}));
    socket.on('telemetry-event', () => {
      scheduleRefresh();
    });
    socket.on('finetune-progress', payload => {
      state.finetuneLive = payload;
      renderFinetune();
    });
    socket.on('finetune-complete', () => {
      state.finetuneLive = null;
      loadSummary();
    });
    socket.on('finetune-error', () => {
      state.finetuneLive = null;
      loadSummary();
    });
  }

  loadSummary();
  state.refreshTimer = setInterval(loadSummary, 5000);
  if (state.refreshTimer.unref) state.refreshTimer.unref();
})();
