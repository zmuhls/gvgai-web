import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_BYTES = 64000;
const ACTIONS = ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE', 'ACTION_NIL'];
const response = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' }
});

function authorized(request, secret) {
  if (!secret || secret.length < 32) return false;
  const provided = request.headers.get('Authorization') || '';
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(provided), hash(`Bearer ${secret}`));
}

async function boundedJson(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw new Error('too-large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid-json');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('too-large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function validInput(input) {
  if (!['clef', 'clef-flash'].includes(input?.model) || !input.state || typeof input.state !== 'object') return false;
  if (Object.keys(input.questions || {}).join() !== 'action') return false;
  const question = input.questions.action;
  const choices = Object.keys(question?.criteria || {});
  return question?.type === 'choice' && typeof question.instructions === 'string' &&
    question.instructions.length <= 8000 && choices.length >= 2 && choices.length <= ACTIONS.length &&
    choices.every(action => ACTIONS.includes(action) && typeof question.criteria[action] === 'string' && question.criteria[action].length <= 4000) &&
    Array.isArray(input.state.legalActions) && input.state.legalActions.length === choices.length &&
    new Set(input.state.legalActions).size === choices.length && input.state.legalActions.every(action => choices.includes(action));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return response({ status: env.RELAY_SECRET?.length >= 32 ? 'ok' : 'unconfigured', service: 'inference-arcade-clef' }, env.RELAY_SECRET?.length >= 32 ? 200 : 503);
    }
    if (url.pathname !== '/v1/decision') return response({ error: 'Not found' }, 404);
    if (request.method !== 'POST') return response({ error: 'POST required' }, 405);
    if (!authorized(request, env.RELAY_SECRET)) return response({ error: 'Unauthorized' }, 401);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return response({ error: 'JSON required' }, 415);
    let input;
    try { input = await boundedJson(request); }
    catch (error) { return response({ error: 'Invalid decision body' }, error.message === 'too-large' ? 413 : 400); }
    if (!validInput(input)) return response({ error: 'A CLEF legal-action choice is required' }, 400);
    try {
      // Only the two decision models can be invoked. No account API token is stored.
      const result = await env.AI.run(`@cf/cloudflare/${input.model}`, {
        model: input.model, state: input.state, questions: input.questions
      });
      return response({ success: true, result });
    } catch {
      console.error(JSON.stringify({ event: 'clef_request_failed', model: input.model }));
      return response({ success: false, error: 'CLEF inference failed' }, 502);
    }
  }
};
