const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panelHTML = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'panel.html'),
  'utf8'
);

test('result panel header is draggable', () => {
  assert.match(
    panelHTML,
    /\.header\s*\{[^}]*-webkit-app-region:\s*drag\s*;/s
  );
});

test('header buttons remain clickable inside the drag region', () => {
  assert.match(
    panelHTML,
    /\.hbtn\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/s
  );
});
