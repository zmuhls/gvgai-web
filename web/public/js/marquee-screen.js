// Pure display-gate logic for the marble-run marquee, factored out of marquee.js
// so it can be unit-tested under `node --test`. Decides when the decorative
// attract animation paints versus when the live game frame holds.
//
// The rule: the attract screen is an IDLE / LOADING state only. Once a real
// frame has arrived for the current case, HOLD it between moves. LLM moves are
// seconds apart (a cloud model can take well over a second per action, and a
// new screenshot is only written after each action), so a short frame-staleness
// timeout must never flip the display back to the "ATTRACT LOOP ACTIVE" template
// while the model is still playing. Case boundaries reset the screen (a new
// case-started clears lastImage), so a stalled stream self-heals when the next
// case begins rather than by guessing a staleness threshold.
(function (global) {
  'use strict';

  var PLAYING_MODES = { MARBLE_PLAYING: true, MARBLE_STARTING: true };

  // mode: latest marble-run mode from marble-run-state.
  // hasLiveFrame: whether a real game-frame has been drawn for the current case.
  // betweenCases: a case boundary in an ongoing run (case-started/-completed
  // seen this session) — show the quiet interstitial card over the held frame
  // instead of the full attract template, which read as a flash.
  function resolveScreen(mode, hasLiveFrame, betweenCases) {
    if (!PLAYING_MODES[mode]) return 'attract';       // idle / yielding / walk-up
    if (hasLiveFrame) return 'live';
    if (betweenCases) return 'interstitial';           // next case loading mid-run
    return 'attract';                                  // first-ever load
  }

  function shouldShowAttract(mode, hasLiveFrame) {
    return resolveScreen(mode, hasLiveFrame, false) === 'attract';
  }

  var api = { shouldShowAttract: shouldShowAttract, resolveScreen: resolveScreen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.MarqueeScreen = api;
})(typeof window !== 'undefined' ? window : null);
