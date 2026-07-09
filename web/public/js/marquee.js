// Read-only spectator view for the attract-mode marble run. Consumes the same
// global Socket.IO event stream the walk-up viewer uses, plus the marble-run-state
// / case-started / case-completed boundary events. No controls — embeddable via
// <iframe> on inference-arcade.com as one "room" in the network.
(function () {
  const DEFAULT_ATTRACT_MODELS = [
    'Gemma 3 27B',
    'Qwen3 Coder Next',
    'Ministral 3 14B',
    'Ministral 3 8B',
    'Devstral Small 2 24B'
  ];
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
    attractModels: DEFAULT_ATTRACT_MODELS,
    attractModelIndex: -1
  };

  // --- game screen ---------------------------------------------------------
  // Frame pipeline mirrors the walk-up viewer (app.js): queue the newest frame,
  // decode it fully off-screen, then clear+draw in one synchronous rAF turn.
  // At async-mode frame rates (~30fps) the old onload path could interleave
  // with attract paints and tear; this one can't, and stale frames are dropped.
  const frameState = { pending: null, rafId: null, decoding: false, hasLiveFrame: false };
  let betweenCases = false;
  const interCard = { last: null, next: null };
  let attractOffset = 0;
  let attractRaf = null;

  function queueGameFrame(dataUrl) {
    if (!dataUrl) return;
    frameState.pending = dataUrl; // newest wins; server already dedupes by digest
    if (frameState.rafId || frameState.decoding) return;
    frameState.rafId = requestAnimationFrame(drawQueuedFrame);
  }

  async function drawQueuedFrame() {
    frameState.rafId = null;
    const dataUrl = frameState.pending;
    frameState.pending = null;
    if (!dataUrl || dataUrl.length < 80) return;
    frameState.decoding = true;
    const img = new Image();
    img.decoding = 'async';
    try {
      img.src = dataUrl;
      if (img.decode) {
        await img.decode();
      } else {
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      }
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        publishFrameSize(w, h);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      frameState.hasLiveFrame = true;
      betweenCases = false;
      marqueeState.screen = 'live';
    } catch (err) {
      // Bad frame: drop it and keep whatever is on screen; the next good
      // frame (or the gate) recovers the display.
    } finally {
      frameState.decoding = false;
      if (frameState.pending && !frameState.rafId) {
        frameState.rafId = requestAnimationFrame(drawQueuedFrame);
      }
    }
  }

  // Tell the host page (marble popout) the real frame aspect so the embed can
  // stop guessing 16:9 and letterbox correctly. Same-origin iframe only.
  function publishFrameSize(width, height) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({ type: 'marble-frame-size', width, height }, window.location.origin);
    } catch (err) { /* sandboxed or detached parent — cosmetic only */ }
  }

  // Delegates to the unit-tested pure gate (marquee-screen.js). No time-based
  // staleness: once a live frame exists for an active case, HOLD it between
  // moves; at case boundaries show the interstitial card, never the full
  // attract template (that alternation read as flashing).
  function resolveScreen() {
    const gate = (typeof MarqueeScreen !== 'undefined' && MarqueeScreen.resolveScreen) || null;
    if (gate) return gate(marqueeState.mode, frameState.hasLiveFrame, betweenCases);
    const playing = marqueeState.mode === 'MARBLE_PLAYING' || marqueeState.mode === 'MARBLE_STARTING';
    if (!playing) return 'attract';
    if (frameState.hasLiveFrame) return 'live';
    return betweenCases ? 'interstitial' : 'attract';
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
  function attractModelForTime(t) {
    const list = marqueeState.attractModels.length ? marqueeState.attractModels : DEFAULT_ATTRACT_MODELS;
    const index = Math.floor(t / 2.4) % list.length;
    return { index, name: list[index] };
  }
  function setAttractNowPlaying(modelInfo) {
    if (!modelInfo || marqueeState.mode !== 'IDLE') return;
    if (marqueeState.attractModelIndex === modelInfo.index) return;
    marqueeState.attractModelIndex = modelInfo.index;
    const np = el('nowplaying');
    np.replaceChildren();
    np.append(document.createTextNode('Marquee cycling '));
    const model = document.createElement('strong');
    model.textContent = modelInfo.name;
    np.append(model, document.createTextNode(' through the arcade.'));
  }
  function drawAttractFrame(rawNow) {
    const now = rawNow + attractOffset;
    const t = now / 1000;
    const modelInfo = attractModelForTime(t);
    setAttractNowPlaying(modelInfo);
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
    drawPixelText('MODEL', 15, 62, '#e0b25a', 9);
    drawPixelText(modelInfo.name.toUpperCase(), 15, 76, '#e4fbf0', 11);
    drawPixelText('STREAM READY', 213, 18, '#e0b25a', 10);
    drawPixelText(`TICK ${String(Math.floor(t * 12) % 9999).padStart(4, '0')}`, 226, 34, '#e4fbf0', 10);
  }
  // Quiet case-boundary card: a translucent wash over whatever is on the
  // canvas (usually the last held frame) with the last result and what loads
  // next. Deliberately no clearRect and no canvas resize — no layout jump.
  function drawInterstitialFrame(rawNow) {
    const t = (rawNow + attractOffset) / 1000;
    marqueeState.screen = 'interstitial';
    ctx.fillStyle = 'rgba(2, 6, 5, 0.66)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const midY = Math.round(canvas.height / 2);
    const pulse = 0.6 + Math.sin(t * 3) * 0.25;
    if (interCard.last) drawPixelText(interCard.last, 14, midY - 26, '#e4fbf0', 12);
    if (interCard.next) drawPixelText(interCard.next, 14, midY - 4, `rgba(123, 239, 195, ${pulse})`, 12);
    drawPixelText('MARBLE RUN', 14, midY + 20, '#e0b25a', 9);
  }
  function startAttractLoop() {
    if (attractRaf) return;
    const step = now => {
      const screen = resolveScreen();
      if (screen === 'attract') drawAttractFrame(now);
      else if (screen === 'interstitial') drawInterstitialFrame(now);
      // 'live': paint nothing — the frame pipeline owns the canvas.
      attractRaf = requestAnimationFrame(step);
    };
    attractRaf = requestAnimationFrame(step);
  }
  // Case boundary: reset the HUD and frame state but do NOT clear the canvas
  // or paint the attract template — the interstitial covers the held frame.
  function softResetForCase() {
    frameState.hasLiveFrame = false;
    frameState.pending = null;
    el('score').textContent = '0';
    el('health').textContent = '—';
    el('tick').textContent = '0';
    marqueeState.score = 0;
    marqueeState.health = null;
    marqueeState.tick = 0;
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
  function modelNameFrom(item) {
    return item && (item.modelName || item.model?.name || item.modelId || item.model?.id || null);
  }
  function rememberAttractModels(current, upNext) {
    const names = [];
    const add = name => {
      if (!name || names.includes(name)) return;
      names.push(name);
    };
    add(modelNameFrom(current));
    (upNext || []).forEach(item => add(modelNameFrom(item)));
    marqueeState.attractModels = names.length ? names : DEFAULT_ATTRACT_MODELS;
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
    rememberAttractModels(s.current, s.upNext);
    const playing = s.mode === 'MARBLE_PLAYING' || s.mode === 'MARBLE_STARTING';
    // Leaving the run entirely (idle / walk-up / yield) ends the boundary
    // state, so the full attract template legitimately returns.
    if (!playing) betweenCases = false;
    setLive(playing, prettyMode(s.mode));
    el('loop').textContent = `Loop ${s.loopCount || 0}`;
    el('playlist-pos').textContent = s.total ? `Case ${(s.cursor || 0) + 1} / ${s.total}` : '—';
    if (s.current) setNowPlaying(s.current);
    else if (s.walkupActive) el('nowplaying').textContent = 'A visitor is at the cabinet — marble run paused.';
    else {
      marqueeState.attractModelIndex = -1;
      setAttractNowPlaying(attractModelForTime((performance.now() + attractOffset) / 1000));
    }
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
    softResetForCase();
    betweenCases = true;
    el('narration').replaceChildren();
    latestPlanTape = null;
    el('ticker').textContent = '—';
    if (c && c.model && c.game) {
      const model = c.model.name || c.model.id || 'model';
      const game = c.game.name || `game ${c.game.id}`;
      rememberAttractModels({ modelName: model }, null);
      interCard.next = `NEXT: ${model} × ${game}`.toUpperCase();
      setNowPlaying({
        modelName: c.model.name, modelId: c.model.id,
        gameName: c.game.name, gameId: c.game.id,
        strategyLabel: c.strategy && c.strategy.label
      });
    } else {
      interCard.next = 'NEXT CASE LOADING';
    }
  });
  socket.on('case-completed', (c) => {
    if (!c) return;
    betweenCases = true;
    frameState.hasLiveFrame = false;
    const box = el('ticker');
    box.replaceChildren();
    if (c.result) {
      const outcome = c.result.won ? 'WIN' : (c.result.winner || 'done');
      interCard.last = `LAST: ${outcome} · SCORE ${c.result.finalScore}`.toUpperCase();
      const b = document.createElement('b');
      b.textContent = `${outcome} · score ${c.result.finalScore}`;
      box.append(b, document.createTextNode(` (${c.endedBy})`));
    } else {
      interCard.last = `LAST: ENDED (${c.endedBy})`.toUpperCase();
      box.textContent = `ended: ${c.endedBy}`;
    }
  });
  // The socket carries every run's events (walk-up play included). The marquee
  // spectates the marble run only, so drop anything that arrives while the run
  // isn't live — otherwise walk-up frames fight the attract painter (flashing).
  function acceptsMarbleEvents(source) {
    const gate = (typeof MarqueeScreen !== 'undefined' && MarqueeScreen.acceptFrame) || null;
    if (gate) return gate(marqueeState.mode, source);
    const playing = marqueeState.mode === 'MARBLE_PLAYING' || marqueeState.mode === 'MARBLE_STARTING';
    return playing && (source == null || source === 'marble');
  }

  socket.on('game-frame', (data) => {
    if (!acceptsMarbleEvents(data && data.source)) return;
    queueGameFrame(data && data.image);
  });
  socket.on('game-state', (s) => {
    if (!s) return;
    if (!acceptsMarbleEvents(null)) return;
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
  socket.on('llm-reasoning', (data) => {
    if (!acceptsMarbleEvents(null)) return;
    addNarration(data);
  });

  function renderGameToText() {
    return JSON.stringify({
      coordinateSystem: 'canvas origin is top-left; x increases right, y increases down',
      mode: marqueeState.mode,
      screen: resolveScreen(),
      attractModel: attractModelForTime((performance.now() + attractOffset) / 1000).name,
      score: marqueeState.score,
      health: marqueeState.health,
      tick: marqueeState.tick,
      hasLiveFrame: frameState.hasLiveFrame,
    });
  }

  window.render_game_to_text = renderGameToText;
  window.advanceTime = ms => {
    attractOffset += Math.max(0, Number(ms) || 0);
    const screen = resolveScreen();
    if (screen === 'attract') drawAttractFrame(performance.now());
    else if (screen === 'interstitial') drawInterstitialFrame(performance.now());
    return renderGameToText();
  };

  drawAttractFrame(performance.now());
  startAttractLoop();

  // Hydrate on load in case we missed the connection-time snapshot.
  fetch('/api/marble/state').then(r => r.json()).then(renderState).catch(() => {});
})();
