// Read-only spectator view for the attract-mode marble run. Consumes the same
// global Socket.IO event stream the walk-up viewer uses, plus the marble-run-state
// / case-started / case-completed boundary events. No controls — embeddable via
// <iframe> on inference-arcade.com as one "room" in the network.
(function () {
  const socket = io();
  const el = id => document.getElementById(id);
  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');
  const marqueeState = {
    mode: 'IDLE',
    screen: 'attract',
    score: 0,
    health: null,
    tick: 0,
  };

  // --- game screen ---------------------------------------------------------
  let lastImage = null;
  let attractOffset = 0;
  let attractRaf = null;
  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth && (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight)) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    marqueeState.screen = 'live-frame';
    ctx.drawImage(img, 0, 0);
  };
  // On decode failure: clear lastImage so shouldShowAttract() can flip back
  // to the attract template instead of silently freezing on a bad frame.
  img.onerror = () => {
    lastImage = null;
    marqueeState.screen = 'attract';
  };
  function drawFrame(dataUrl) {
    if (!dataUrl || dataUrl === lastImage) return;
    lastImage = dataUrl;
    img.src = dataUrl;
  }
  // Delegates to the unit-tested pure gate (marquee-screen.js). No time-based
  // staleness: once a live frame exists for an active case, HOLD it between the
  // multi-second gaps of LLM moves instead of flashing the attract template.
  function shouldShowAttract() {
    const gate = (typeof MarqueeScreen !== 'undefined' && MarqueeScreen.shouldShowAttract) || null;
    if (gate) return gate(marqueeState.mode, Boolean(lastImage));
    // Fallback if the gate script failed to load: attract only when not in an
    // active case, or before the first frame arrives.
    const playing = marqueeState.mode === 'MARBLE_PLAYING' || marqueeState.mode === 'MARBLE_STARTING';
    return !playing || !lastImage;
  }
  function ensureAttractCanvas() {
    if (canvas.width !== 320 || canvas.height !== 240) {
      canvas.width = 320;
      canvas.height = 240;
    }
  }
  function drawPixelText(text, x, y, color, size) {
    ctx.save();
    ctx.font = `${size || 10}px "IBM Plex Mono", monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillText(text, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
  function drawAttractFrame(rawNow) {
    const now = rawNow + attractOffset;
    const t = now / 1000;
    ensureAttractCanvas();
    marqueeState.screen = 'attract';

    ctx.fillStyle = '#020605';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const pulse = 0.35 + Math.sin(t * 2.2) * 0.12;
    const glow = ctx.createRadialGradient(230, 68, 0, 230, 68, 190);
    glow.addColorStop(0, `rgba(123, 239, 195, ${pulse})`);
    glow.addColorStop(0.34, 'rgba(34, 86, 70, 0.22)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(210, 251, 237, 0.42)';
    for (let i = 0; i < 34; i += 1) {
      const x = (i * 37 + t * 22) % 340 - 10;
      const y = 18 + ((i * 29) % 126);
      const r = (i % 3) + 1;
      ctx.fillRect(Math.round(x), y, r, r);
    }

    const laneY = 168 + Math.sin(t * 1.6) * 6;
    ctx.strokeStyle = 'rgba(123, 239, 195, 0.42)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = -10; x <= 330; x += 18) {
      const y = laneY + Math.sin((x * 0.05) + t * 2.1) * 12;
      if (x === -10) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#1f3f34';
    ctx.beginPath();
    ctx.moveTo(0, 212);
    for (let x = 0; x <= 320; x += 20) {
      ctx.lineTo(x, 198 + Math.sin((x * 0.07) + t) * 10);
    }
    ctx.lineTo(320, 240);
    ctx.lineTo(0, 240);
    ctx.closePath();
    ctx.fill();

    const marbleX = 34 + ((t * 62) % 252);
    const marbleY = laneY + Math.sin((marbleX * 0.05) + t * 2.1) * 12 - 13;
    for (let i = 5; i > 0; i -= 1) {
      ctx.fillStyle = `rgba(123, 239, 195, ${0.08 * (6 - i)})`;
      ctx.beginPath();
      ctx.arc(marbleX - i * 9, marbleY + Math.sin(t * 8 - i) * 2, 6 + i, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#7befc3';
    ctx.beginPath();
    ctx.arc(marbleX, marbleY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e4fbf0';
    ctx.fillRect(marbleX - 2, marbleY - 4, 3, 3);

    const gateX = 248 + Math.sin(t * 1.7) * 14;
    ctx.strokeStyle = 'rgba(224, 178, 90, 0.85)';
    ctx.lineWidth = 3;
    ctx.strokeRect(gateX, 95, 28, 54);
    ctx.fillStyle = 'rgba(224, 178, 90, 0.18)';
    ctx.fillRect(gateX + 3, 98, 22, 48);

    drawPixelText('AI MARBLE RUN', 14, 15, '#e4fbf0', 15);
    drawPixelText('ATTRACT LOOP ACTIVE', 15, 37, '#7befc3', 10);
    drawPixelText('STREAM READY', 213, 18, '#e0b25a', 10);
    drawPixelText(`TICK ${String(Math.floor(t * 12) % 9999).padStart(4, '0')}`, 226, 34, '#e4fbf0', 10);
  }
  function startAttractLoop() {
    if (attractRaf) return;
    const step = now => {
      if (shouldShowAttract()) drawAttractFrame(now);
      attractRaf = requestAnimationFrame(step);
    };
    attractRaf = requestAnimationFrame(step);
  }
  function resetScreen() {
    lastImage = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    el('score').textContent = '0';
    el('health').textContent = '—';
    el('tick').textContent = '0';
    marqueeState.score = 0;
    marqueeState.health = null;
    marqueeState.tick = 0;
    drawAttractFrame(performance.now());
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
    marqueeState.mode = s.mode || 'IDLE';
    const playing = s.mode === 'MARBLE_PLAYING' || s.mode === 'MARBLE_STARTING';
    setLive(playing, prettyMode(s.mode));
    el('loop').textContent = `Loop ${s.loopCount || 0}`;
    el('playlist-pos').textContent = s.total ? `Case ${(s.cursor || 0) + 1} / ${s.total}` : '—';
    if (s.current) setNowPlaying(s.current);
    else if (s.walkupActive) el('nowplaying').textContent = 'A visitor is at the cabinet — marble run paused.';
    else el('nowplaying').textContent = 'Attract loop running — waiting for the next marble.';
    renderUpNext(s.upNext);
  }

  // --- narration -----------------------------------------------------------
  let latestPlanTape = null;

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
    b.textContent = data.action ? String(data.action).replace(/^ACTION_/, '') : '—';
    act.append(document.createTextNode('→ '), b);
    if (data.provider) act.append(document.createTextNode(` · ${data.provider}`));
    if (typeof data.elapsed === 'number' && data.elapsed > 0) act.append(document.createTextNode(` · ${data.elapsed}ms`));
    entry.append(reason, act);
    if (Array.isArray(data.plan) && data.plan.length > 1) {
      const tape = document.createElement('div');
      tape.className = 'plan-tape';
      data.plan.forEach((step, i) => {
        const cell = document.createElement('span');
        cell.className = 'plan-cell' + (i === 0 ? ' is-live' : '');
        cell.textContent = String(step).replace(/^ACTION_/, '');
        tape.appendChild(cell);
      });
      const count = document.createElement('span');
      count.className = 'plan-count';
      count.textContent = `1/${data.plan.length}`;
      tape.appendChild(count);
      entry.appendChild(tape);
      latestPlanTape = tape;
    } else {
      latestPlanTape = null;
    }
    box.insertBefore(entry, box.firstChild);
    while (box.children.length > 12) box.removeChild(box.lastChild);
  }

  function advancePlanTape(s) {
    if (!latestPlanTape || !s || !(s.planLength > 1)) return;
    const cells = latestPlanTape.querySelectorAll('.plan-cell');
    const liveIdx = Math.max(1, Math.min(s.planStep, cells.length)) - 1;
    cells.forEach((cell, i) => {
      cell.classList.remove('is-live', 'is-done');
      if (i < liveIdx) cell.classList.add('is-done');
      else if (i === liveIdx) cell.classList.add('is-live');
    });
    const count = latestPlanTape.querySelector('.plan-count');
    if (count) count.textContent = `${Math.max(1, Math.min(s.planStep, s.planLength))}/${s.planLength}`;
  }

  // --- wiring --------------------------------------------------------------
  socket.on('connect', () => setLive(false, 'connected'));
  socket.on('disconnect', () => setLive(false, 'disconnected'));
  socket.on('marble-run-state', renderState);
  socket.on('case-started', (c) => {
    resetScreen();
    el('narration').replaceChildren();
    latestPlanTape = null;
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
    if (s.score != null) {
      el('score').textContent = s.score;
      marqueeState.score = s.score;
    }
    if (s.health != null) {
      el('health').textContent = s.health;
      marqueeState.health = s.health;
    }
    if (s.tick != null) {
      el('tick').textContent = s.tick;
      marqueeState.tick = s.tick;
    }
    advancePlanTape(s);
  });
  socket.on('llm-reasoning', addNarration);

  function renderGameToText() {
    return JSON.stringify({
      coordinateSystem: 'canvas origin is top-left; x increases right, y increases down',
      mode: marqueeState.mode,
      screen: marqueeState.screen,
      score: marqueeState.score,
      health: marqueeState.health,
      tick: marqueeState.tick,
      hasLiveFrame: Boolean(lastImage),
    });
  }

  window.render_game_to_text = renderGameToText;
  window.advanceTime = ms => {
    attractOffset += Math.max(0, Number(ms) || 0);
    drawAttractFrame(performance.now());
    return renderGameToText();
  };

  drawAttractFrame(performance.now());
  startAttractLoop();

  // Hydrate on load in case we missed the connection-time snapshot.
  fetch('/api/marble/state').then(r => r.json()).then(renderState).catch(() => {});
})();
