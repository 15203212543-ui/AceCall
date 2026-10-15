const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider } = require('../providers');

test('creates the three supported transcription providers', () => {
  assert.equal(createProvider('baidu').name, 'baidu');
  assert.equal(createProvider('whisper').name, 'whisper');
  assert.equal(createProvider('funasr').name, 'funasr');
});

test('rejects unsupported transcription providers', () => {
  assert.throws(() => createProvider('unknown'), /不支持的转写引擎/);
});
