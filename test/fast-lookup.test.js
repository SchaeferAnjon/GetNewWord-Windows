const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'zhipu.js'),
  'utf8'
);

test('DeepSeek V4 receives the configured thinking mode', () => {
  const provider = source.match(/deepseek:\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(provider, 'DeepSeek provider should exist');
  assert.match(provider[1], /supportsThinking:\s*true/);
});

test('quick extraction has enough output budget for complete JSON', () => {
  const quick = source.match(/async function quickExtract[\s\S]*?sendRequest\(\[message\],\s*\{\s*maxTokens:\s*(\d+)[^}]*\}/);
  assert.ok(quick, 'quick extraction token budget should be explicit');
  assert.ok(Number(quick[1]) >= 256);
});
