const assert = require('node:assert/strict');
const test = require('node:test');

const {
  availableTournamentModels,
  discoverOllamaCloudModels,
  discoverOllamaLocalModels,
  selectTournamentRoster
} = require('../lib/tournament-roster');

test('discovers installed Ollama models as local tournament players', async () => {
  const localFetchFn = async () => ({
    ok: true,
    async json() {
      return { models: [{ name: 'qwen3:8b' }, { name: 'qwen3-agent:latest' }, { name: 'embed-model' }] };
    }
  });
  const discovered = await discoverOllamaLocalModels({ localFetchFn });
  const available = await availableTournamentModels({ localOnly: true, localFetchFn });

  assert.equal(discovered.status, 'ready');
  assert.deepEqual(discovered.models.map(model => model.id), ['qwen3:8b', 'qwen3-agent:latest']);
  assert.ok(available.models.every(model => model.provider === 'ollama-local'));
  assert.equal(available.providerMode, 'ollama-local');
});

test('discovers remote players without duplicating catalog models', async () => {
  const fetchFn = async () => ({
    ok: true,
    async json() {
      return { models: [{ name: 'known' }, { name: 'new-player' }, { name: 'embed-model' }] };
    }
  });
  const discovered = await discoverOllamaCloudModels({ apiKey: 'test', fetchFn });
  const available = await availableTournamentModels({
    apiKey: 'test',
    fetchFn,
    catalog: [{ id: 'known', name: 'Known', provider: 'ollama-cloud' }]
  });

  assert.equal(discovered.status, 'ready');
  assert.deepEqual(discovered.models.map(model => model.id), ['known', 'new-player']);
  assert.deepEqual(available.models.map(model => model.id), ['known', 'new-player']);
  assert.equal(available.discoveredCount, 1);
});

test('retains leaders and introduces players absent from the previous tournament', () => {
  const available = 'abcdefghijklmno'.split('').map(id => ({ id, name: id.toUpperCase() }));
  const history = [{
    participants: 'abcdefghijk'.split(''),
    standings: 'abcdefghijk'.split('').map((modelId, index) => ({ modelId, rank: index + 1 }))
  }];
  const roster = selectTournamentRoster(available, history, { rosterSize: 8, challengerCount: 4 });

  assert.deepEqual(roster.models.slice(0, 4).map(model => model.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(roster.newPlayerIds, ['l', 'm', 'n', 'o']);
  assert.equal(roster.models.length, 8);
});
