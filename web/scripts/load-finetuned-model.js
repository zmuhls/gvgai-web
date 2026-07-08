#!/usr/bin/env node
'use strict';

// Load a trained GGUF into local Ollama (manual step after copying a model
// back from the Legion — see scripts/FINETUNE.md).
//
// Usage: node scripts/load-finetuned-model.js --id gvgai-aliens-ft-... --gguf models/<id>/unsloth.Q4_K_M.gguf

const { loadModel, isOllamaAvailable, LoaderError } = require('../lib/ollama-loader');

function argValue(name) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}

async function main() {
  const modelId = argValue('id');
  const ggufPath = argValue('gguf');
  if (!modelId || !ggufPath) {
    console.error('Usage: node scripts/load-finetuned-model.js --id=<modelId> --gguf=<path.gguf>');
    process.exit(1);
  }
  if (!(await isOllamaAvailable())) {
    console.error('Ollama daemon is not reachable on the configured ollama.apiUrl');
    process.exit(2);
  }
  try {
    const result = await loadModel({ modelId, ggufPath });
    console.log(JSON.stringify(result));
  } catch (err) {
    if (err instanceof LoaderError) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exit(2);
    }
    throw err;
  }
}

main();
