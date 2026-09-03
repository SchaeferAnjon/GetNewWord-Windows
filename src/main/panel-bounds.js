const PANEL_WIDTH = 544;
const PANEL_MAX_HEIGHT = 792;
const PANEL_CURSOR_OFFSET = 16;
const PANEL_EDGE_MARGIN = 10;
const PANEL_VERTICAL_RESERVE = 60;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function panelSizeForWorkArea(workArea) {
  return {
    width: Math.min(PANEL_WIDTH, Math.max(1, workArea.width - PANEL_EDGE_MARGIN * 2)),
    height: Math.min(PANEL_MAX_HEIGHT, Math.max(1, workArea.height - PANEL_VERTICAL_RESERVE))
  };
}

function boundsNearCursor(cursor, workArea) {
  const { width, height } = panelSizeForWorkArea(workArea);
  return {
    x: Math.round(clamp(
      cursor.x + PANEL_CURSOR_OFFSET,
      workArea.x + PANEL_EDGE_MARGIN,
      workArea.x + workArea.width - width - PANEL_EDGE_MARGIN
    )),
    y: Math.round(clamp(
      cursor.y + PANEL_CURSOR_OFFSET,
      workArea.y + PANEL_EDGE_MARGIN,
      workArea.y + workArea.height - height - PANEL_EDGE_MARGIN
    )),
    width,
    height
  };
}

function boundsInsideWorkArea(bounds, workArea) {
  const size = panelSizeForWorkArea(workArea);
  const height = Math.min(
    Math.max(1, bounds.height || size.height),
    Math.max(1, workArea.height - PANEL_EDGE_MARGIN * 2)
  );
  return {
    x: Math.round(clamp(
      bounds.x,
      workArea.x + PANEL_EDGE_MARGIN,
      workArea.x + workArea.width - size.width - PANEL_EDGE_MARGIN
    )),
    y: Math.round(clamp(
      bounds.y,
      workArea.y + PANEL_EDGE_MARGIN,
      workArea.y + workArea.height - height - PANEL_EDGE_MARGIN
    )),
    // Always restore the intended width. This repairs a panel that Windows left
    // as a thin visible strip after a DPI or monitor-layout change.
    width: size.width,
    height
  };
}

module.exports = {
  PANEL_WIDTH,
  boundsNearCursor,
  boundsInsideWorkArea
};
