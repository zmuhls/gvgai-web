const assert = require('node:assert/strict');
const test = require('node:test');

const { authorizeOperator } = require('../lib/operator-auth');

function requestWithAuthorization(authorization) {
  return {
    headers: authorization ? { authorization } : {},
    get(name) {
      return String(name).toLowerCase() === 'authorization' ? authorization : undefined;
    }
  };
}

test('operator actions remain disabled until their feature flag is an exact opt-in', () => {
  const result = authorizeOperator(
    requestWithAuthorization('Bearer correct'),
    {
      env: {
        MARBLE_RUN_ENABLED: 'false',
        MODEL_CONTROL_TOKEN: 'correct'
      },
      enabledKey: 'MARBLE_RUN_ENABLED'
    }
  );

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: 'This operator action is disabled.'
  });
});

test('operator actions require a configured bearer token', () => {
  const missingConfig = authorizeOperator(requestWithAuthorization(), {
    env: { MODEL_EVALS_ENABLED: 'true' },
    enabledKey: 'MODEL_EVALS_ENABLED'
  });
  assert.equal(missingConfig.status, 503);

  const unauthorized = authorizeOperator(requestWithAuthorization('Bearer wrong'), {
    env: {
      MODEL_EVALS_ENABLED: 'true',
      MODEL_CONTROL_TOKEN: 'correct'
    },
    enabledKey: 'MODEL_EVALS_ENABLED'
  });
  assert.equal(unauthorized.status, 401);
});

test('operator actions admit the matching bearer token after explicit enablement', () => {
  const result = authorizeOperator(requestWithAuthorization('Bearer correct'), {
    env: {
      MODEL_FINETUNE_ENABLED: 'true',
      MODEL_CONTROL_TOKEN: 'correct'
    },
    enabledKey: 'MODEL_FINETUNE_ENABLED'
  });

  assert.deepEqual(result, { ok: true });
});
