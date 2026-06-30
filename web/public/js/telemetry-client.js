(function () {
  if (!window.arcadeSocket && typeof window.io === 'function') {
    window.arcadeSocket = window.io();
  }

  const storageKey = 'inferenceArcadeTelemetrySession';
  let sessionId = window.sessionStorage.getItem(storageKey);
  if (!sessionId) {
    sessionId = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(storageKey, sessionId);
  }

  function cleanPayload(payload) {
    return {
      path: window.location.pathname,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      ...payload
    };
  }

  window.telemetryTrack = function telemetryTrack(eventType, payload = {}, metrics = {}, options = {}) {
    if (!eventType) return;
    const body = {
      eventFamily: options.eventFamily || 'user_experience',
      eventType,
      source: 'browser',
      sessionId,
      gameId: options.gameId,
      levelId: options.levelId,
      modelId: options.modelId,
      provider: options.provider,
      latencyMs: options.latencyMs,
      value: options.value,
      payload: cleanPayload(payload),
      metrics
    };

    fetch('/api/telemetry/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(() => {});
  };

  window.addEventListener('load', () => {
    window.telemetryTrack('page_loaded', {
      title: document.title
    });
  });

  document.addEventListener('click', event => {
    const navButton = event.target.closest('#main-nav .nav-link');
    if (!navButton) return;
    window.telemetryTrack('nav_clicked', {
      target: navButton.dataset.target,
      label: navButton.textContent.trim()
    }, {}, { eventFamily: 'clickthrough' });
  }, true);
})();
