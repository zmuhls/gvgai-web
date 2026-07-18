(function () {
  'use strict';

  var popout = document.getElementById('marble-popout');
  if (!popout) return;

  var expandBtn = document.getElementById('marble-popout-expand');
  var closeBtn = document.getElementById('marble-popout-close');
  var reopenBtn = document.getElementById('marble-popout-reopen');
  var lamp = document.getElementById('marble-popout-lamp');
  var status = document.getElementById('marble-popout-status');
  var iframe = popout.querySelector('iframe');
  var iframeSrc = iframe ? iframe.getAttribute('src') : null;
  var startRequested = false;
  var pointerStartY = null;

  function iframeUrl(expanded) {
    if (!iframeSrc) return null;
    var url = new URL(iframeSrc, window.location.origin);
    if (expanded) url.searchParams.set('view', 'full');
    else url.searchParams.delete('view');
    return url.pathname + url.search;
  }

  function track(eventType, payload) {
    if (typeof window.telemetryTrack === 'function') {
      window.telemetryTrack(eventType, payload || {}, {}, { eventFamily: 'clickthrough' });
    }
  }

  function setExpanded(expanded) {
    popout.classList.toggle('is-expanded', expanded);
    if (expandBtn) {
      expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      expandBtn.setAttribute('aria-label', expanded ? 'Shrink autoplay game' : 'Expand autoplay game');
      expandBtn.setAttribute('title', expanded ? 'Shrink' : 'Expand');
      expandBtn.textContent = expanded ? '▣' : '□';
    }
    if (iframe && iframeSrc && iframe.getAttribute('src') === 'about:blank') {
      iframe.setAttribute('src', iframeSrc);
    }
    if (iframe) {
      var nextSrc = iframeUrl(expanded);
      if (nextSrc && iframe.getAttribute('src') !== nextSrc) {
        iframe.setAttribute('src', nextSrc);
      }
    }
    if (expanded) startUniversalMarbleRun('expand');
    track(expanded ? 'marble_popout_expanded' : 'marble_popout_shrunk');
  }

  function closePopout() {
    popout.classList.add('is-hidden');
    popout.classList.remove('is-expanded');
    startRequested = false;   // let a later reopen re-request the stream
    if (reopenBtn) {
      reopenBtn.hidden = false;
      reopenBtn.classList.add('is-visible');
    }
    if (iframe) iframe.setAttribute('src', 'about:blank');
    track('marble_popout_closed');
  }

  function reopenPopout() {
    popout.classList.remove('is-hidden');
    if (reopenBtn) {
      reopenBtn.hidden = true;
      reopenBtn.classList.remove('is-visible');
    }
    if (iframe && iframeSrc) iframe.setAttribute('src', iframeUrl(false) || iframeSrc);
    startUniversalMarbleRun('reopen');
    track('marble_popout_reopened');
  }

  function updateStatus(mode) {
    var state = 'off';
    var label = 'idle';

    switch (mode) {
      case 'MARBLE_PLAYING':
        state = 'on';
        label = 'live';
        break;
      case 'MARBLE_STARTING':
        state = 'warn';
        label = 'loading';
        break;
      case 'WALKUP_PLAYING':
        state = 'warn';
        label = 'visitor';
        break;
      case 'YIELDING':
      case 'RESUMING':
        state = 'warn';
        label = 'switching';
        break;
      case 'IDLE':
        state = 'on';
        label = 'attract';
        break;
      default:
        label = mode ? String(mode).toLowerCase().replace(/_/g, ' ') : 'idle';
    }

    if (lamp) lamp.setAttribute('data-state', state);
    if (status) status.textContent = label;
  }

  function startUniversalMarbleRun(source) {
    if (startRequested) return;
    startRequested = true;
    updateStatus('MARBLE_STARTING');
    fetch('/api/marble/start', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true
    })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (snapshot) {
        if (snapshot) updateStatus(snapshot.mode);
        track('marble_stream_requested', { source: source || 'dwell' });
      })
      .catch(function () {
        updateStatus('IDLE');
      });
  }

  function isMobileDrawer() {
    return window.matchMedia &&
      window.matchMedia('(max-width: 700px), ((max-height: 520px) and (max-width: 900px))').matches;
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', function () {
      setExpanded(!popout.classList.contains('is-expanded'));
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', closePopout);

  if (reopenBtn) reopenBtn.addEventListener('click', reopenPopout);

  popout.addEventListener('click', function (event) {
    if (!isMobileDrawer() || popout.classList.contains('is-expanded')) return;
    if (event.target.closest('.marble-popout-action')) return;
    setExpanded(true);
  });

  popout.addEventListener('pointerdown', function (event) {
    if (!isMobileDrawer()) return;
    pointerStartY = event.clientY;
  });

  popout.addEventListener('pointerup', function (event) {
    if (!isMobileDrawer() || pointerStartY == null) return;
    var deltaY = event.clientY - pointerStartY;
    pointerStartY = null;
    if (deltaY < -34 && !popout.classList.contains('is-expanded')) {
      setExpanded(true);
    } else if (deltaY > 42 && popout.classList.contains('is-expanded')) {
      setExpanded(false);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && popout.classList.contains('is-expanded')) {
      setExpanded(false);
    }
  });

  function bindSocket(attempt) {
    var socket = window.arcadeSocket;
    if (!socket) {
      if (attempt < 20) setTimeout(function () { bindSocket(attempt + 1); }, 250);
      return;
    }

    if (socket.connected && status) status.textContent = 'connected';
    socket.on('connect', function () {
      if (status) status.textContent = 'connected';
    });
    socket.on('disconnect', function () {
      updateStatus('IDLE');
    });
    socket.on('marble-run-state', function (snapshot) {
      updateStatus(snapshot && snapshot.mode);
    });
  }

  bindSocket(0);

  // The embedded marquee reports each new frame's true pixel size so the
  // collapsed popout can match the game's aspect instead of guessing.
  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) return;
    if (!iframe || event.source !== iframe.contentWindow) return;
    var data = event.data;
    if (!data || data.type !== 'marble-frame-size') return;
    var w = Number(data.width);
    var h = Number(data.height);
    if (!(w > 0) || !(h > 0)) return;
    popout.style.setProperty('--marble-popout-aspect', w + ' / ' + h);
  });

  fetch('/api/marble/state')
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (snapshot) {
      if (snapshot) updateStatus(snapshot.mode);
    })
    .catch(function () {
      if (status) status.textContent = 'offline';
    });

  window.setTimeout(function () {
    startUniversalMarbleRun('dwell');
  }, 5000);
})();
