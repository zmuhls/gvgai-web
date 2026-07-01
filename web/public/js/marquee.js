// Read-only spectator view for the attract-mode marble run. Consumes the same
// global Socket.IO event stream the walk-up viewer uses, plus the marble-run-state
// / case-started / case-completed boundary events. No controls — embeddable via
// <iframe> on inference-arcade.com as one "room" in the network.
(function () {
  const socket = io();
  const el = id => document.getElementById(id);
  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');

  // --- game screen ---------------------------------------------------------
  let lastImage = null;
  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth && (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight)) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    ctx.drawImage(img, 0, 0);
  };
  function drawFrame(dataUrl) {
    if (!dataUrl || dataUrl === lastImage) return;
    lastImage = dataUrl;
    img.src = dataUrl;
  }
  function resetScreen() {
    lastImage = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    el('score').textContent = '0';
    el('health').textContent = '—';
    el('tick').textContent = '0';
  }

  // --- chrome --------------------------------------------------------------
  function setLive(on, text) {
    el('live').classList.toggle('on', !!on);
    el('live-text').textContent = text;
  }
  function prettyMode(mode) {
    switch (mode) {
      case 'MARBLE_PLAYING': return 'live';
      case 'MARBLE_STARTING': return 'loading…';
      case 'WALKUP_PLAYING': return 'visitor playing';
      case 'YIELDING': return 'yielding…';
      case 'RESUMING': return 'resuming…';
      case 'IDLE': return 'idle';
      default: return mode || '—';
    }
  }
  function setNowPlaying(c) {
    const np = el('nowplaying');
    np.replaceChildren();
    const model = document.createElement('strong');
    model.textContent = c.modelName || c.modelId || 'model';
    np.append(model, document.createTextNode(' playing '));
    const game = document.createElement('strong');
    game.textContent = c.gameName || `game ${c.gameId}`;
    np.append(game);
    if (c.strategyLabel) np.append(document.createTextNode(` — “${c.strategyLabel}”`));
  }
  function renderUpNext(list) {
    const box = el('upnext');
    box.replaceChildren();
    if (!list || !list.length) { box.textContent = '—'; return; }
    for (const item of list) {
      const div = document.createElement('div');
      div.className = 'upnext-item';
      const b = document.createElement('b');
      b.textContent = item.modelName || '';
      div.append(b, document.createTextNode(` · ${item.gameName || ''} · ${item.strategyLabel || ''}`));
      box.appendChild(div);
    }
  }
  function renderState(s) {
    if (!s) return;
    const playing = s.mode === 'MARBLE_PLAYING' || s.mode === 'MARBLE_STARTING';
    setLive(playing, prettyMode(s.mode));
    el('loop').textContent = `Loop ${s.loopCount || 0}`;
    el('playlist-pos').textContent = s.total ? `Case ${(s.cursor || 0) + 1} / ${s.total}` : '—';
    if (s.current) setNowPlaying(s.current);
    else if (s.walkupActive) el('nowplaying').textContent = 'A visitor is at the cabinet — marble run paused.';
    else el('nowplaying').textContent = 'Waiting for the next marble…';
    renderUpNext(s.upNext);
  }

  // --- narration -----------------------------------------------------------
  function addNarration(data) {
    if (!data) return;
    const box = el('narration');
    const entry = document.createElement('div');
    entry.className = 'entry';
    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent = data.reason || data.response || '(thinking…)';
    const act = document.createElement('div');
    act.className = 'act';
    const b = document.createElement('b');
    b.textContent = data.action || '—';
    act.append(document.createTextNode('→ '), b);
    if (data.provider) act.append(document.createTextNode(` · ${data.provider}`));
    if (typeof data.elapsed === 'number' && data.elapsed > 0) act.append(document.createTextNode(` · ${data.elapsed}ms`));
    entry.append(reason, act);
    box.insertBefore(entry, box.firstChild);
    while (box.children.length > 12) box.removeChild(box.lastChild);
  }

  // --- wiring --------------------------------------------------------------
  socket.on('connect', () => setLive(false, 'connected'));
  socket.on('disconnect', () => setLive(false, 'disconnected'));
  socket.on('marble-run-state', renderState);
  socket.on('case-started', (c) => {
    resetScreen();
    el('narration').replaceChildren();
    el('ticker').textContent = '—';
    if (c && c.model && c.game) {
      setNowPlaying({
        modelName: c.model.name, modelId: c.model.id,
        gameName: c.game.name, gameId: c.game.id,
        strategyLabel: c.strategy && c.strategy.label
      });
    }
  });
  socket.on('case-completed', (c) => {
    if (!c) return;
    const box = el('ticker');
    box.replaceChildren();
    if (c.result) {
      const b = document.createElement('b');
      b.textContent = `${c.result.won ? 'WIN' : (c.result.winner || 'done')} · score ${c.result.finalScore}`;
      box.append(b, document.createTextNode(` (${c.endedBy})`));
    } else {
      box.textContent = `ended: ${c.endedBy}`;
    }
  });
  socket.on('game-frame', (data) => drawFrame(data && data.image));
  socket.on('game-state', (s) => {
    if (!s) return;
    if (s.score != null) el('score').textContent = s.score;
    if (s.health != null) el('health').textContent = s.health;
    if (s.tick != null) el('tick').textContent = s.tick;
  });
  socket.on('llm-reasoning', addNarration);

  // Hydrate on load in case we missed the connection-time snapshot.
  fetch('/api/marble/state').then(r => r.json()).then(renderState).catch(() => {});
})();
