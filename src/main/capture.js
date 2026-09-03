// capture.js — 框选截图：每个屏幕一张全分辨率截图 + 全屏覆盖层拖拽框选
// 覆盖层渲染进程负责：暗色遮罩、选区清晰显示、mouseup 后裁剪 + 四周扩展语境 + 画红框（与 macOS 版逻辑一致）

const { BrowserWindow, desktopCapturer, screen, app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('./applog');

let overlays = [];
let pending = null;   // { resolve }

function screenshotDir() {
  const dir = path.join(app.getPath('userData'), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/// 开始框选。resolve：null（取消）或
/// { pngPath, panelDataURL, apiDataURL(1200px jpeg), quickDataURL(1000px jpeg) }
async function captureRegion() {
  if (pending) return null;

  const displays = screen.getAllDisplays();
  // 全分辨率抓屏（thumbnailSize 按物理像素）
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(...displays.map(d => d.size.width * d.scaleFactor)),
        height: Math.max(...displays.map(d => d.size.height * d.scaleFactor))
      }
    });
  } catch (e) {
    log(`[Capture] getSources failed: ${e.message}`);
    return null;
  }
  if (!sources.length) return null;

  return new Promise((resolve) => {
    pending = { resolve };
    displays.forEach((display, i) => {
      // display_id 匹配；匹配不到按顺序兜底
      const source = sources.find(s => String(s.display_id) === String(display.id)) || sources[i] || sources[0];
      const win = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
        show: false,
        frame: false, transparent: false, backgroundColor: '#000000',
        alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
        enableLargerThanScreen: true, hasShadow: false, fullscreenable: false,
        webPreferences: { preload: path.join(__dirname, '..', '..', 'preload.js') }
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'overlay.html'));
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('overlay:init', {
          imageDataURL: source.thumbnail.toDataURL(),
          quality: 0.9
        });
      });
      overlays.push(win);
    });
  });
}

function closeOverlays() {
  for (const w of overlays) { try { w.destroy(); } catch {} }
  overlays = [];
}

function finish(result) {
  closeOverlays();
  if (!pending) return;
  const { resolve } = pending;
  pending = null;
  if (!result) { resolve(null); return; }
  // 保存 PNG（词库/Anki 用）
  let pngPath = null;
  try {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    pngPath = path.join(screenshotDir(), `screenshot_${ts}.png`);
    fs.writeFileSync(pngPath, Buffer.from(result.pngDataURL.split(',')[1], 'base64'));
  } catch (e) { log(`[Capture] save png failed: ${e.message}`); }
  log(`[Capture] region captured ${result.width}x${result.height}`);
  resolve({
    pngPath,
    panelDataURL: result.pngDataURL,
    apiDataURL: result.apiDataURL,
    quickDataURL: result.quickDataURL
  });
}

function registerIPC() {
  ipcMain.on('overlay:ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !overlays.includes(win) || win.isDestroyed()) return;
    // Do not expose the black BrowserWindow background while the screenshot is
    // still decoding. The renderer sends this only after its first full draw.
    win.show();
    win.focus();
  });
  ipcMain.on('overlay:done', (_e, result) => finish(result));
  ipcMain.on('overlay:cancel', () => finish(null));
}

module.exports = { captureRegion, registerIPC };
