function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeCandidate(overrides = {}) {
  return {
    id: 'ollama:deepseek-v4-flash',
    provider: 'ollama-cloud',
    apiUrl: 'https://ollama.example/v1/chat/completions',
    model: 'deepseek-v4-flash',
    apiKey: 'test-token',
    ...overrides
  };
}

function sequenceFetch(responses, calls = []) {
  let index = 0;
  return async (url, options = {}) => {
    calls.push({ url, options });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof response === 'function' ? response(url, options, index - 1) : response;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

module.exports = {
  deferred,
  jsonResponse,
  makeCandidate,
  sequenceFetch
};
