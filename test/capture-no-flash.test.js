const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const captureJS = fs.readFileSync(path.join(root, 'src', 'main', 'capture.js'), 'utf8');
const overlayHTML = fs.readFileSync(path.join(root, 'renderer', 'overlay.html'), 'utf8');

test('capture overlay stays hidden until its screenshot is painted', () => {
  assert.match(captureJS, /new BrowserWindow\(\{[\s\S]*?show:\s*false/);
  assert.match(captureJS, /ipcMain\.on\('overlay:ready'/);
  assert.match(captureJS, /win\.show\(\)/);
});

test('renderer announces readiness after the first draw', () => {
  const onload = overlayHTML.match(/img\.onload\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(onload, 'image onload handler should exist');
  assert.ok(onload[1].indexOf('draw();') < onload[1].indexOf("gnw.send('overlay:ready')"));
});
