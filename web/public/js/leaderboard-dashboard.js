(function () {
  const state = { loaded: false, loading: false, data: null };

  function node(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const target = node(id);
    if (target) target.textContent = value == null ? '—' : String(value);
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'date unavailable';
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function stageLabel(stage) {
    if (stage === 'champion') return 'champion';
    if (stage === 'final') return 'finalist';
    if (stage === 'semifinal') return 'semifinal';
    if (stage === 'qualifier') return 'qualifier';
    return stage || 'tournament';
  }

  function appendText(parent, tag, text, className) {
    const child = document.createElement(tag);
    if (className) child.className = className;
    child.textContent = text;
    parent.appendChild(child);
    return child;
  }

  function resultSummary(row) {
    const parts = [];
    if (row.wins) parts.push(`${row.wins} win${row.wins === 1 ? '' : 's'}`);
    if (row.qualifiedGames) parts.push(`${row.qualifiedGames} qualified`);
    if (row.runs) parts.push(`${row.runs} games`);
    if (parts.length) return parts.join(' · ');
    if (row.placementPoints) return `${row.placementPoints} placement pts`;
    return 'advanced';
  }

  function renderStandings(rows) {
    const table = node('leaderboard-standings');
    if (!table) return;
    table.replaceChildren();

    const header = document.createElement('div');
    header.className = 'tournament-standing-row tournament-standing-head';
    header.setAttribute('role', 'row');
    ['Rank', 'Player', 'Result', 'Score'].forEach(label => appendText(header, 'span', label));
    table.appendChild(header);

    rows.forEach(row => {
      const line = document.createElement('div');
      line.className = `tournament-standing-row${row.rank === 1 ? ' is-champion' : ''}`;
      line.setAttribute('role', 'row');
      appendText(line, 'strong', String(row.rank).padStart(2, '0'), 'tournament-rank');
      const player = document.createElement('span');
      appendText(player, 'strong', row.modelName || row.modelId);
      appendText(player, 'small', stageLabel(row.stage));
      line.appendChild(player);
      appendText(line, 'span', resultSummary(row));
      appendText(line, 'strong', row.totalScore || row.placementPoints || 0);
      table.appendChild(line);
    });
  }

  function renderNewPlayers(players) {
    const box = node('leaderboard-new-players');
    if (!box) return;
    box.replaceChildren();
    if (!players.length) {
      appendText(box, 'p', 'Returning field — no first-time challenger was recorded.', 'tournament-empty');
      return;
    }
    players.forEach(player => {
      const chip = document.createElement('div');
      chip.className = 'tournament-challenger';
      appendText(chip, 'span', 'NEW');
      appendText(chip, 'strong', player.modelName || player.modelId);
      box.appendChild(chip);
    });
  }

  function renderGames(games) {
    const box = node('leaderboard-games');
    if (!box) return;
    box.replaceChildren();
    games.forEach(game => {
      const card = document.createElement('article');
      appendText(card, 'span', game.gameId == null ? '—' : String(game.gameId).padStart(3, '0'));
      appendText(card, 'strong', game.gameName);
      appendText(card, 'small', game.winner ? `won by ${game.winner}` : `${game.qualifiedModels || 0} qualified · no outright winner`);
      box.appendChild(card);
    });
  }

  function renderHistory(history) {
    const box = node('leaderboard-history');
    if (!box) return;
    box.replaceChildren();
    history.forEach((record, index) => {
      const card = document.createElement('article');
      card.className = `tournament-history-card${index === 0 ? ' is-latest' : ''}`;
      appendText(card, 'span', formatDate(record.generatedAt));
      appendText(card, 'strong', record.champion?.modelName || 'No champion recorded');
      appendText(card, 'small', `${record.participantCount} players · ${record.matchesPlayed} matches · ${record.gameCount} games`);
      box.appendChild(card);
    });
  }

  function render(data) {
    const latest = data.latest;
    if (!latest) throw new Error('No tournament records have been published yet.');
    setText('leaderboard-updated', formatDate(latest.generatedAt));
    setText('leaderboard-champion-name', latest.champion?.modelName || 'No champion recorded');
    setText('leaderboard-champion-reason', latest.champion?.reason || 'Top-ranked across the latest recorded tournament field.');
    setText('leaderboard-player-count', latest.participantCount);
    setText('leaderboard-match-count', latest.matchesPlayed);
    setText('leaderboard-game-count', latest.gameCount);
    setText('leaderboard-record-count', data.recordCount);
    setText('leaderboard-source', latest.sourceFile);
    renderStandings(latest.standings || []);
    renderNewPlayers(latest.newPlayers || []);
    renderGames(latest.games || []);
    renderHistory(data.history || []);
  }

  function renderError(error) {
    const box = node('leaderboard-error');
    if (!box) return;
    box.hidden = false;
    box.textContent = `Leaderboard unavailable: ${error.message}`;
  }

  async function loadLeaderboard(force = false) {
    if (state.loading || (state.loaded && !force)) return;
    state.loading = true;
    const errorBox = node('leaderboard-error');
    if (errorBox) errorBox.hidden = true;
    try {
      const response = await fetch('/api/leaderboard');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = await response.json();
      render(state.data);
      state.loaded = true;
      if (typeof window.telemetryTrack === 'function') {
        window.telemetryTrack('leaderboard_viewed', {
          tournamentId: state.data.latest?.id || null,
          recordCount: state.data.recordCount || 0
        }, {}, { eventFamily: 'clickthrough' });
      }
    } catch (error) {
      renderError(error);
    } finally {
      state.loading = false;
    }
  }

  document.querySelectorAll('#main-nav .nav-link').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.target === 'leaderboard-dashboard') loadLeaderboard();
    });
  });
})();
