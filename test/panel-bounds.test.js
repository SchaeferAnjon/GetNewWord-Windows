const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PANEL_WIDTH,
  boundsNearCursor,
  boundsInsideWorkArea
} = require('../src/main/panel-bounds');

test('keeps a new panel fully inside a display near its right edge', () => {
  const workArea = { x: 1920, y: 0, width: 1920, height: 1040 };
  const bounds = boundsNearCursor({ x: 3835, y: 500 }, workArea);

  assert.equal(bounds.width, PANEL_WIDTH);
  assert.equal(bounds.x + bounds.width, workArea.x + workArea.width - 10);
  assert.ok(bounds.y >= workArea.y + 10);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height - 10);
});

test('handles displays with negative coordinates', () => {
  const workArea = { x: -2560, y: -120, width: 2560, height: 1400 };
  const bounds = boundsNearCursor({ x: -2600, y: -200 }, workArea);

  assert.equal(bounds.x, workArea.x + 10);
  assert.equal(bounds.y, workArea.y + 10);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width - 10);
});

test('restores a collapsed pinned panel and clamps it onscreen', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const bounds = boundsInsideWorkArea(
    { x: 1850, y: -200, width: 146, height: 900 },
    workArea
  );

  assert.equal(bounds.width, PANEL_WIDTH);
  assert.equal(bounds.x + bounds.width, workArea.width - 10);
  assert.equal(bounds.y, 10);
  assert.ok(bounds.y + bounds.height <= workArea.height - 10);
});

test('shrinks safely only when the work area is narrower than the panel', () => {
  const workArea = { x: 0, y: 0, width: 480, height: 800 };
  const bounds = boundsNearCursor({ x: 470, y: 790 }, workArea);

  assert.equal(bounds.width, 460);
  assert.equal(bounds.x, 10);
  assert.equal(bounds.x + bounds.width, 470);
});
