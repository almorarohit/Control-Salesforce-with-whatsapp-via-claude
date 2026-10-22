import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaUrl } from '../src/config.js';

test('ollamaUrl accepts Ollama host:port as well as full URLs', () => {
  assert.equal(ollamaUrl('127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrl('https://ollama.local'), 'https://ollama.local');
  assert.equal(ollamaUrl(undefined), 'http://127.0.0.1:11434');
});
