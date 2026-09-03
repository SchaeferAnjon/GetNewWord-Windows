const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainJS = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const panelHTML = fs.readFileSync(path.join(root, 'renderer', 'panel.html'), 'utf8');

test('main process confirms the requested pinned state', () => {
  assert.match(mainJS, /ipcMain\.handle\('panel:setPinned'/);
  assert.match(mainJS, /panelPinned\s*=\s*Boolean\(pinned\)/);
  assert.match(mainJS, /return panelPinned/);
});

test('pin button waits for main-process confirmation', () => {
  assert.match(panelHTML, /await gnw\.invoke\('panel:setPinned',\s*!pinned\)/);
  assert.match(panelHTML, /setPinnedState\(confirmed\)/);
  assert.match(panelHTML, /aria-pressed/);
});
