'use strict';

// Loads a fine-tuned GGUF into the local Ollama daemon (`ollama create`) so the
// existing ollama-local provider branch in llm-client.js can serve it. Zero
// coupling to the LLM client itself.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getConfig } = require('./runtime-config');

const execFileAsync = promisify(execFile);

class LoaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LoaderError';
    this.code = code;
  }
}

function ollamaOrigin() {
  try {
    return new URL(getConfig().ollama.apiUrl).origin;
  } catch {
    return 'http://localhost:11434';
  }
}

// Fast boolean probe; never throws. Railway (no local daemon) returns false
// within the abort window.
async function isOllamaAvailable(timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ollamaOrigin()}/api/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Prefer the Unsloth-generated Modelfile (it carries the right chat TEMPLATE)
// but rewrite its FROM to the absolute GGUF path — Unsloth writes a local
// relative reference. The generated fallback deliberately has NO TEMPLATE
// line: Ollama then reads the chat template from the GGUF's embedded
// tokenizer.chat_template metadata, which beats hand-writing a Go-template.
// (`max_tokens` is not an Ollama parameter; the knob is num_predict.)
function resolveModelfile(ggufPath) {
  const absGguf = path.resolve(ggufPath);
  const unslothModelfile = path.join(path.dirname(absGguf), 'Modelfile');
  if (fs.existsSync(unslothModelfile)) {
    const content = fs.readFileSync(unslothModelfile, 'utf-8');
    if (/^FROM .*/m.test(content)) {
      return content.replace(/^FROM .*/m, `FROM ${absGguf}`);
    }
    return `FROM ${absGguf}\n${content}`;
  }
  return `FROM ${absGguf}\nPARAMETER temperature 0.7\nPARAMETER num_predict 200\n`;
}

async function loadModel({ modelId, ggufPath, ollamaBin = 'ollama' }) {
  if (!modelId || !ggufPath) {
    throw new LoaderError('GGUF_MISSING', 'modelId and ggufPath are required');
  }
  const absGguf = path.resolve(ggufPath);
  if (!fs.existsSync(absGguf)) {
    throw new LoaderError('GGUF_MISSING', `GGUF not found: ${absGguf}`);
  }

  const modelfilePath = path.join(path.dirname(absGguf), 'Modelfile.ollama');
  fs.writeFileSync(modelfilePath, resolveModelfile(absGguf));

  try {
    await execFileAsync(ollamaBin, ['create', modelId, '-f', modelfilePath], {
      timeout: 120000
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LoaderError('OLLAMA_CLI_MISSING', `ollama CLI not found (${ollamaBin})`);
    }
    throw new LoaderError('OLLAMA_CREATE_FAILED',
      `ollama create failed: ${err.stderr || err.message}`);
  }

  // Verify the tag actually landed.
  try {
    const res = await fetch(`${ollamaOrigin()}/api/tags`);
    const data = await res.json();
    const found = (data.models || []).some(m =>
      m.name === modelId || m.name === `${modelId}:latest` || (m.name || '').startsWith(`${modelId}:`));
    if (!found) {
      throw new LoaderError('OLLAMA_CREATE_FAILED',
        `ollama create succeeded but ${modelId} is missing from /api/tags`);
    }
  } catch (err) {
    if (err instanceof LoaderError) throw err;
    // Daemon reachable enough to create but tags probe failed: treat as loaded.
    console.warn('[OllamaLoader] tag verification skipped:', err.message);
  }

  return { loaded: true, modelId };
}

module.exports = { isOllamaAvailable, loadModel, resolveModelfile, LoaderError };
