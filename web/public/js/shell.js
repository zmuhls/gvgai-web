// Arcade shell chrome: boot overlay, titlebar clock, connection lamp,
// and the WebAudio blip engine. Classic script, no dependencies —
// if anything in here fails the app must keep working, so every
// section is guarded and the boot overlay ships hidden in markup.
(function () {
  'use strict';

  var reducedMotion = false;
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { /* matchMedia unavailable — treat as no preference */ }

  // ── boot screen ────────────────────────────────────────────────
  // Shown once per session, skippable by click or any key, hard
  // auto-dismiss so it can never trap the page.
  try {
    var boot = document.getElementById('boot-screen');
    var BOOT_FLAG = 'arcade-booted';
    if (boot && !reducedMotion && !sessionStorage.getItem(BOOT_FLAG)) {
      sessionStorage.setItem(BOOT_FLAG, '1');
      boot.hidden = false;
      boot.setAttribute('aria-hidden', 'false');

      var dismissed = false;
      var dismiss = function () {
        if (dismissed) return;
        dismissed = true;
        boot.hidden = true;
        boot.remove();
        document.removeEventListener('keydown', dismiss, true);
      };
      boot.addEventListener('click', dismiss);
      document.addEventListener('keydown', dismiss, true);
      setTimeout(dismiss, 2500);
    } else if (boot) {
      boot.remove();
    }
  } catch (_) { /* no boot screen — app unaffected */ }

  // ── titlebar clock ─────────────────────────────────────────────
  try {
    var clock = document.getElementById('titlebar-clock');
    if (clock) {
      var tick = function () {
        var d = new Date();
        clock.textContent =
          String(d.getHours()).padStart(2, '0') + ':' +
          String(d.getMinutes()).padStart(2, '0');
      };
      tick();
      setInterval(tick, 15000);
    }
  } catch (_) { /* clock stays at --:-- */ }

  // ── sound engine ───────────────────────────────────────────────
  // Off by default; the AudioContext is only ever constructed inside
  // the toggle's click handler (a user gesture), per autoplay policy.
  var SOUND_KEY = 'arcade-sound';
  var soundOn = false;
  var audioCtx = null;

  try {
    soundOn = localStorage.getItem(SOUND_KEY) === 'on';
  } catch (_) { /* private mode — default off */ }

  function ensureContext() {
    if (!soundOn) return null;
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // A short square-wave blip; freqs is an array for tiny arpeggios.
  function blip(freqs, dur) {
    try {
      var ctx = soundOn ? audioCtx : null;
      if (!ctx || ctx.state !== 'running') return;
      var t = ctx.currentTime;
      freqs.forEach(function (f, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, t + i * dur);
        gain.gain.exponentialRampToValueAtTime(0.06, t + i * dur + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + (i + 1) * dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + i * dur);
        osc.stop(t + (i + 1) * dur + 0.02);
      });
    } catch (_) { /* never let audio break the app */ }
  }

  var cues = {
    toggle: function () { blip([660], 0.08); },
    start: function () { blip([440, 660, 880], 0.09); },
    levelEnd: function () { blip([523, 784], 0.12); },
    summary: function () { blip([392, 523, 659, 784], 0.11); },
    error: function () { blip([196, 147], 0.14); }
  };

  function updateSoundButton(btn) {
    btn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    btn.textContent = soundOn ? 'SND ON' : 'SND OFF';
  }

  try {
    var soundBtn = document.getElementById('sound-toggle');
    if (soundBtn) {
      updateSoundButton(soundBtn);
      soundBtn.addEventListener('click', function () {
        soundOn = !soundOn;
        try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch (_) {}
        updateSoundButton(soundBtn);
        if (soundOn) {
          ensureContext();
          cues.toggle();
        }
      });
      // If sound was left on from a previous visit, the context still
      // needs a fresh gesture — arm it on the first click anywhere.
      if (soundOn) {
        document.addEventListener('pointerdown', function arm() {
          ensureContext();
          document.removeEventListener('pointerdown', arm);
        });
      }
    }
  } catch (_) { /* sound toggle inert */ }

  // ── connection lamp + socket-driven cues ──────────────────────
  // telemetry-client.js defines window.arcadeSocket before this file
  // runs; the retry covers any load-order drift. Listeners are
  // read-only — the shell never emits.
  function bindSocket(attempt) {
    var socket = window.arcadeSocket;
    if (!socket) {
      if (attempt < 20) setTimeout(function () { bindSocket(attempt + 1); }, 250);
      return;
    }
    var lamp = document.getElementById('conn-lamp');
    var setLamp = function (state) {
      if (lamp) lamp.setAttribute('data-state', state);
    };
    if (socket.connected) setLamp('on');
    socket.on('connect', function () { setLamp('on'); });
    socket.on('disconnect', function () { setLamp('off'); });
    socket.on('connect_error', function () { setLamp('err'); });

    var lastFrameAt = 0;
    socket.on('game-frame', function () {
      var now = Date.now();
      if (now - lastFrameAt > 5000) cues.start();
      lastFrameAt = now;
    });
    socket.on('level-end', function () { cues.levelEnd(); });
    socket.on('run-summary', function () { cues.summary(); });
    socket.on('llm-error', function () { cues.error(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindSocket(0); });
  } else {
    bindSocket(0);
  }
})();
