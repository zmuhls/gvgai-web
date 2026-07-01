(function () {
  const socket = window.arcadeSocket;
  const state = {
    snapshot: null,
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

  const metricCards = [
    {
      key: 'evaluations',
      label: 'Evaluations',
      detail: 'runs, cases, summaries',
      format: value => formatNumber(value)
    },
    {
      key: 'userExperienceEvents',
      label: 'User Experience',
      detail: 'views, searches, sockets',
      format: value => formatNumber(value)
    },
    {
      key: 'clickthroughRate',
      label: 'Clickthrough Rate',
      detail: 'start clicks / selections',
      format: value => formatPercent(value)
    },
    {
      key: 'averageModelLatencyMs',
      label: 'Model Latency',
      detail: 'mean decision time',
      format: value => `${formatNumber(value)}ms`
    },
    {
      key: 'traceEvents',
      label: 'Trace Volume',
      detail: 'sampled state ticks',
      format: value => formatNumber(value)
    }
  ];

  async function loadSummary() {
    try {
      const response = await fetch('/api/telemetry/summary?limit=80');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.snapshot = await response.json();
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

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    setText('telemetry-storage-status', snapshot.storage?.label || 'unknown');
    setText('telemetry-live-clients', `${snapshot.liveClients || 0} clients`);
    setText('telemetry-fallback-status', sourceLabel(snapshot));
    setText('telemetry-events-rate', formatNumber(snapshot.metrics?.eventsPerMinute || 0));
    setText('telemetry-stream-count', `${formatNumber(snapshot.metrics?.totalEvents || 0)} events`);
    setText('telemetry-leaderboard-source', sourceLabel(snapshot));
    setText('telemetry-pipeline-source', pipelineLabel(snapshot.pipeline, snapshot));

    renderLeaderboards(snapshot.leaderboards || {});
    renderMetrics(snapshot.metrics || {});
    renderPipeline(snapshot.pipeline || {});
    renderFlow(snapshot);
    renderEvents(snapshot.recentEvents || []);
    renderEvalChart(snapshot.evalOutcomes || {});
    renderFunnel(snapshot.funnel || {});
    renderModelChart(snapshot.models || []);
    renderTraceChart(snapshot.traceTypes || []);
    renderMarbleRun(snapshot.marbleRun || {});
  }

  // The Tote Board: per-model standings + strategy effect from the marble run.
  function renderMarbleRun(marble) {
    setText('telemetry-marble-total', `${formatNumber(marble.totalCases || 0)} cases`);

    const standings = document.getElementById('telemetry-marble-standings');
    if (standings) {
      const rows = marble.standings || [];
      standings.innerHTML = rows.length ? rows.map(row => `
        <div class="bar-row" style="--bar-width: ${Math.max(4, row.winRate)}%;">
          <span>${escapeHtml(row.modelId)} <small>${row.meanScore} avg · ${row.strongAdherenceRate}% adhere · ${row.fallbackRate}% fallback</small></span>
          <strong>${row.winRate}% W</strong>
        </div>
      `).join('') : '<div class="telemetry-empty">No marble-run cases yet</div>';
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

  function renderMetrics(metrics) {
    const container = document.getElementById('telemetry-metrics');
    if (!container) return;

    container.innerHTML = metricCards.map(card => `
      <article class="telemetry-metric electric-panel">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.format(metrics[card.key] || 0))}</strong>
        <small>${escapeHtml(card.detail)}</small>
      </article>
    `).join('');
  }

  function renderLeaderboards(leaderboards) {
    renderRunLeaderboard(leaderboards.runs || []);
    renderUsageLeaderboard(leaderboards.usage || []);
    renderSessionLeaderboard(leaderboards.sessions || []);
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

  function formatPercent(value) {
    return `${Math.round(Number(value || 0) * 100)}%`;
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

  if (socket) {
    socket.on('telemetry-event', () => {
      scheduleRefresh();
    });
  }

  loadSummary();
  state.refreshTimer = setInterval(loadSummary, 5000);
  if (state.refreshTimer.unref) state.refreshTimer.unref();
})();
