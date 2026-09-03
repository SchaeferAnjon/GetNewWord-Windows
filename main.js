// main.js — Electron 主进程：窗口编排 / 全局热键 / IPC / 本地文件协议
// 结构对应 macOS 版：主窗口(MainView) + 结果面板(NSPanel) + 框选覆盖层 + 悬浮球 + 错误浮窗

const { app, BrowserWindow, globalShortcut, ipcMain, screen, nativeTheme, protocol, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./src/main/db');
const zhipu = require('./src/main/zhipu');
const anki = require('./src/main/anki');
const audio = require('./src/main/audio');
const capture = require('./src/main/capture');
const analysis = require('./src/main/analysis');
const { log } = require('./src/main/applog');
const { PANEL_WIDTH, boundsNearCursor, boundsInsideWorkArea } = require('./src/main/panel-bounds');

// 本机（macOS）开发测试时隔离数据目录：APFS 大小写不敏感，默认的 "getnewword"
// 会撞上 Mac 版的 "GetNewWord" 数据目录。Windows 上保持默认。
if (process.platform === 'darwin') {
  app.setPath('userData', path.join(app.getPath('appData'), 'GetNewWordWin'));
}

let mainWindow = null;
let panelWindow = null;
let floatWindow = null;
let errorWindow = null;
let panelPinned = false;

const PRELOAD = path.join(__dirname, 'preload.js');
const R = (f) => path.join(__dirname, 'renderer', f);

// ---------- 本地文件协议（音频 / 截图） ----------

protocol.registerSchemesAsPrivileged([{ scheme: 'gnwfile', privileges: { stream: true, bypassCSP: true } }]);

function registerFileProtocol() {
  protocol.handle('gnwfile', (request) => {
    const filePath = decodeURIComponent(request.url.replace('gnwfile://', '').replace(/^\/+/, '/'));
    // 只允许 userData 下的文件
    const userData = app.getPath('userData');
    const resolved = path.resolve(filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath) ? filePath : '/' + filePath);
    if (!resolved.startsWith(userData)) return new Response('forbidden', { status: 403 });
    try {
      const data = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mime = { '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' }[ext] || 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': mime } });
    } catch { return new Response('not found', { status: 404 }); }
  });
}

const fileURL = (p) => p ? 'gnwfile://' + encodeURIComponent(p).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%5C/g, '/') : null;

// data URL：媒体播放最稳的通道（自定义协议在部分 Windows 环境下 <audio>/<img> 不认）
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.aiff': 'audio/aiff' };
function dataURL(p) {
  try {
    const ext = path.extname(p).toLowerCase();
    const data = fs.readFileSync(p);
    return `data:${MIME[ext] || 'application/octet-stream'};base64,${data.toString('base64')}`;
  } catch { return null; }
}

// ---------- 窗口 ----------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 720, minWidth: 1000, minHeight: 620,
    title: 'GetNewWord',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171A' : '#FAFAFB',
    webPreferences: { preload: PRELOAD }
  });
  mainWindow.loadFile(R('main.html'));
  mainWindow.on('close', (e) => {
    // 关窗不退出（热键取词照常工作），从任务栏/悬浮球再打开
    if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.setMenuBarVisibility(false);
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH, height: 700, minWidth: 320,
    show: false, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: PRELOAD }
  });
  panelWindow.setAlwaysOnTop(true, 'floating');
  panelWindow.loadFile(R('panel.html'));
  panelWindow.on('blur', () => {
    // 点面板外 → 关（钉住时不关）
    if (!panelPinned && panelWindow.isVisible()) analysis.dismiss();
  });
}

function showPanel() {
  const cursor = screen.getCursorScreenPoint();
  let bounds;
  if (panelPinned) {
    // 保留钉住位置，但在显示器/DPI 变化后把整个面板拉回可见区域，
    // 并恢复完整宽度，避免只剩下右侧一条窄栏。
    const current = panelWindow.getBounds();
    const display = screen.getDisplayMatching(current);
    bounds = boundsInsideWorkArea(current, display.workArea);
  } else {
    const display = screen.getDisplayNearestPoint(cursor);
    bounds = boundsNearCursor(cursor, display.workArea);
  }
  panelWindow.setBounds(bounds);
  panelSend('panel:setPin', panelPinned);
  panelWindow.show();
  // Windows 在混合 DPI 显示器间首次显示透明无边框窗口时可能重算尺寸；
  // show() 后再次施加同一边界，确保不会以窄条形式出现。
  if (process.platform === 'win32') panelWindow.setBounds(bounds);
}

function hidePanel() { panelPinned = false; panelWindow.hide(); }
function panelSend(channel, data) { try { panelWindow.webContents.send(channel, data); } catch {} }
function refreshMain() {
  try { mainWindow.webContents.send('db-changed'); } catch {}
}

function showError(message) {
  if (errorWindow) { try { errorWindow.destroy(); } catch {} }
  const cursor = screen.getCursorScreenPoint();
  errorWindow = new BrowserWindow({
    width: 380, height: 110, x: cursor.x - 180, y: cursor.y + 20,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false, hasShadow: false,
    webPreferences: { preload: PRELOAD }
  });
  errorWindow.loadFile(R('error.html'));
  errorWindow.webContents.once('did-finish-load', () => errorWindow.webContents.send('error:message', message));
  const w = errorWindow;
  setTimeout(() => { try { w.destroy(); } catch {} }, 8000);
}

function createFloatWindow() {
  if (floatWindow) return;
  const pos = db.getSetting('floatPos');
  const display = screen.getPrimaryDisplay().workArea;
  floatWindow = new BrowserWindow({
    width: 52, height: 52,
    x: pos ? pos.x : display.x + display.width - 70,
    y: pos ? pos.y : Math.round(display.y + display.height / 2 - 120),
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false,
    webPreferences: { preload: PRELOAD }
  });
  floatWindow.setAlwaysOnTop(true, 'floating');
  floatWindow.loadFile(R('float.html'));
  floatWindow.on('moved', () => {
    const [x, y] = floatWindow.getPosition();
    db.setSetting('floatPos', { x, y });
  });
  log('[Float] button shown');
}

function setFloatVisible(on) {
  if (on) { createFloatWindow(); floatWindow.showInactive(); }
  else if (floatWindow) { floatWindow.destroy(); floatWindow = null; }
}

// ---------- 全局热键 ----------

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const acc = db.getSetting('hotkey') || 'CommandOrControl+Shift+A';
  try {
    globalShortcut.register(acc, () => analysis.trigger('capture'));
    if (!acc.includes('Alt')) {
      globalShortcut.register('Alt+' + acc, () => analysis.trigger('lookup'));
    }
    log(`[Hotkey] registered ${acc} (+Alt = 快速查词)`);
  } catch (e) {
    log(`[Hotkey] register failed: ${e.message}`);
  }
}

// ---------- IPC ----------

function serializeAll() {
  return {
    words: db.words(), snippets: db.snippets(), categories: db.categories(),
    settings: db.allSettings()
  };
}

function registerIPC() {
  capture.registerIPC();

  // --- 数据 ---
  ipcMain.handle('db:all', () => serializeAll());
  ipcMain.handle('db:updateWord', (_e, id, patch) => { db.updateWord(id, { ...patch, syncStatus: 'not_synced' }); analysis.scheduleAnkiSync(); return db.word(id); });
  ipcMain.handle('db:deleteWords', async (_e, ids, alsoAnki) => {
    if (alsoAnki) {
      const noteIds = ids.map(id => db.word(id)?.ankiNoteId).filter(Boolean);   // 先取，再删实体
      anki.deleteAnkiNotes(noteIds);
    }
    db.deleteWords(ids);
  });
  ipcMain.handle('db:deleteSnippets', async (_e, ids, alsoAnki) => {
    if (alsoAnki) for (const id of ids) { const s = db.snippet(id); if (s) anki.deleteSnippetNote(s.ankiNoteId, s.title); }
    db.deleteSnippets(ids);
  });
  ipcMain.handle('db:deleteContext', (_e, wordId, contextId) => db.deleteContext(wordId, contextId));
  ipcMain.handle('db:assignCategory', (_e, kind, ids, categoryId) => {
    for (const id of ids) {
      (kind === 'words' ? db.updateWord : db.updateSnippet)(id, { categoryId: categoryId || null, syncStatus: 'not_synced' });
    }
  });
  ipcMain.handle('cat:create', (_e, name, forWords) => db.createCategory(name, forWords));
  ipcMain.handle('cat:rename', (_e, id, name) => db.renameCategory(id, name));
  ipcMain.handle('cat:delete', (_e, id) => db.deleteCategory(id));

  // --- 设置 ---
  ipcMain.handle('settings:set', (_e, key, value) => {
    db.setSetting(key, value);
    if (key === 'hotkey') registerHotkeys();
    if (key === 'showFloatingButton') setFloatVisible(value);
    if (key === 'appearance') nativeTheme.themeSource = value === 'system' ? 'system' : value;
    if (key === 'fontScale' || key === 'appearance') {
      refreshMain();
      panelSend('settings-changed', db.allSettings());
    }
  });

  // --- 分析流程 ---
  ipcMain.handle('analysis:trigger', (_e, mode) => { analysis.trigger(mode || 'capture'); });
  ipcMain.on('panel:dismiss', () => analysis.dismiss());
  ipcMain.on('panel:undo', () => analysis.undoAutoSave());
  ipcMain.on('panel:removeWord', (_e, i) => analysis.removeSavedWord(i));
  ipcMain.on('panel:removeSnippet', (_e, i) => analysis.removeSavedSnippet(i));
  ipcMain.on('panel:toggleSelection', (_e, i) => analysis.toggleSelection(i));
  ipcMain.on('panel:setCategory', (_e, forWords, i, catId) => analysis.setCategory(forWords, i, catId));
  ipcMain.handle('panel:createCategory', (_e, forWords, i, name) => analysis.createCategoryAndAssign(forWords, i, name));
  ipcMain.on('panel:save', () => analysis.saveSelected());
  // Return the authoritative state so the renderer only shows the button as
  // active after the main process has started protecting the panel from blur.
  ipcMain.handle('panel:setPinned', (_e, pinned) => {
    panelPinned = Boolean(pinned);
    return panelPinned;
  });
  ipcMain.on('panel:requestState', () => analysis.pushState());

  // --- 发音 ---
  ipcMain.handle('audio:path', async (_e, text, language) => {
    const p = await audio.generateAudioFile(text, language);
    return p ? dataURL(p) : null;
  });
  ipcMain.handle('file:url', (_e, p) => dataURL(p));

  // --- AI ---
  ipcMain.handle('ai:validateKey', (_e, key, provider) => zhipu.validateKey(key, provider));
  ipcMain.handle('ai:regenerate', async (_e, wordId) => {
    const w = db.word(wordId);
    if (!w) return null;
    const sentence = w.contexts?.[0]?.sentence || w.contextSentence;
    const e = await zhipu.enrichWord(w.word, w.language, w.meaning, sentence);
    const patch = { syncStatus: 'not_synced' };
    if (e.meaning) patch.meaning = e.meaning;              // 释义带上词性分组
    if (e.usage) patch.analysisNote = e.usage;
    if (e.collocations?.length) patch.collocationsText = e.collocations.join('\n');
    if (e.examples?.length) patch.examplesText = e.examples.join('\n');
    if (e.etymology) patch.etymology = e.etymology;
    db.updateWord(wordId, patch);
    analysis.scheduleAnkiSync();
    log(`[Detail] regenerated AI content for '${w.word}'`);
    return db.word(wordId);
  });

  // --- Anki ---
  ipcMain.handle('anki:status', async () => ({ running: await anki.isAnkiRunning() }));
  ipcMain.handle('anki:decks', async () => { try { return await anki.deckNames(); } catch { return []; } });
  ipcMain.handle('anki:sync', async () => { const r = await anki.syncEverythingPending(); refreshMain(); return r; });

  // --- 原生右键菜单 ---
  ipcMain.handle('menu:popup', (e, items) => new Promise((resolve) => {
    const template = items.map(it => it.type === 'separator'
      ? { type: 'separator' }
      : { label: it.label, enabled: it.enabled !== false, click: () => resolve(it.id) });
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: BrowserWindow.fromWebContents(e.sender), callback: () => setTimeout(() => resolve(null), 100) });
  }));

  // --- 导入 / 导出 ---
  ipcMain.handle('export:words', async (_e, format) => {
    const words = db.words();
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const { filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath: `words_${ts}.${format}` });
    if (!filePath) return null;
    if (format === 'csv') {
      const esc = (f) => /[",\n]/.test(f || '') ? `"${(f || '').replace(/"/g, '""')}"` : (f || '');
      let csv = 'word,phonetic,language,meaning,contextSentence,contextTranslation,analysisNote,difficulty,tags,createdAt\n';
      for (const w of words) {
        csv += [w.word, w.phonetic, w.language, w.meaning, w.contextSentence, w.contextTranslation, w.analysisNote, w.difficulty, (w.tags || []).join(';'), w.createdAt].map(esc).join(',') + '\n';
      }
      fs.writeFileSync(filePath, csv, 'utf8');
    } else {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, exportDate: new Date().toISOString(), words }, null, 2));
    }
    shell.showItemInFolder(filePath);
    return filePath;
  });
  ipcMain.handle('import:words', async () => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, { filters: [{ name: 'CSV/JSON', extensions: ['csv', 'json'] }], properties: ['openFile'] });
    if (!filePaths?.length) return { count: 0 };
    const file = filePaths[0];
    const content = fs.readFileSync(file, 'utf8');
    let count = 0;
    try {
      if (file.toLowerCase().endsWith('.json')) {
        const json = JSON.parse(content);
        for (const w of (json.words || [])) {
          if (!w.word || !w.meaning) continue;
          db.saveWord({
            word: w.word, phonetic: w.phonetic, language: w.language, meaning: w.meaning,
            contextMeaning: w.contextMeaning, contextSentence: w.contextSentence || '',
            contextTranslation: w.contextTranslation || '', analysisNote: w.analysisNote || '',
            grammar: w.grammar, difficulty: w.difficulty, examples: []
          }, null, null);
          count++;
        }
      } else {
        const lines = content.split(/\r?\n/).filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          const f = parseCSVLine(lines[i]);
          if (f.length < 8 || !f[0]) continue;
          db.saveWord({
            word: f[0], phonetic: f[1], language: f[2], meaning: f[3],
            contextSentence: f[4] || '', contextTranslation: f[5] || '',
            analysisNote: f[6] || '', difficulty: f[7], examples: []
          }, null, null);
          count++;
        }
      }
      return { count };
    } catch (e) { return { count, error: e.message }; }
  });

  // --- 悬浮球 ---
  ipcMain.on('float:capture', () => analysis.trigger('capture'));
  ipcMain.on('float:lookup', () => analysis.trigger('lookup'));
  ipcMain.on('float:hide', () => { db.setSetting('showFloatingButton', false); setFloatVisible(false); });
  ipcMain.on('float:menu', () => {
    const menu = Menu.buildFromTemplate([
      { label: '截图取词（自动保存）', click: () => analysis.trigger('capture') },
      { label: '快速查词（不保存）', click: () => analysis.trigger('lookup') },
      { type: 'separator' },
      { label: '打开主窗口', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { label: '隐藏悬浮球', click: () => { db.setSetting('showFloatingButton', false); setFloatVisible(false); } }
    ]);
    menu.popup();
  });

  ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('window:showMain', () => { mainWindow.show(); mainWindow.focus(); });
  ipcMain.on('app:quit', () => { app.isQuiting = true; app.quit(); });
  ipcMain.on('error:dismiss', () => { try { errorWindow.destroy(); } catch {} });
}

function parseCSVLine(line) {
  const fields = []; let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

// ---------- 启动 ----------

// 截图回归使用独立测试进程；生产启动仍只允许一个实例。
const gotLock = process.env.GNW_SHOT ? true : app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

  app.whenReady().then(async () => {
    db.load();
    registerFileProtocol();
    nativeTheme.themeSource = db.getSetting('appearance') === 'system' ? 'system' : db.getSetting('appearance');
    registerIPC();
    createMainWindow();
    createPanelWindow();
    if (db.getSetting('showFloatingButton')) createFloatWindow();
    registerHotkeys();
    analysis.init({ showPanel, hidePanel, panelSend, showError, refreshMain });
    db.onChange(() => refreshMain());

    // 调试：GNW_SHOT=1 时自截主窗口和面板（骨架态+结果态）后退出
    if (process.env.GNW_SHOT) {
      setTimeout(async () => {
        const shot = async (win, name) => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(process.env.GNW_SHOT_DIR || ".", name), img.toPNG());
        };
        await shot(mainWindow, "shot-main.png");
        const fake = {
          mode: "capture", analyzing: false, autoSaved: true,
          result: { words: [{ word: "unobstructed", phonetic: "ˌʌnəbˈstrʌktɪd", language: "en",
            meaning: "adj. 无阻碍的；畅通的；视野开阔的", contextMeaning: "无阻碍的",
            contextSentence: "You are driving on a wide road on which oncoming traffic can pass unobstructed.",
            contextTranslation: "你正行驶在一条宽阔的道路上，对向来车可以无阻碍地通行。",
            grammar: "", difficulty: "b2", category: "英语", suggestedCategory: null }], snippets: [] },
          quickWord: { word: "unobstructed", language: "en" },
          screenshotDataURL: null, selectedIndices: [0], skippedAsDuplicate: [],
          removedWords: [], removedSnippets: [], savedWordIds: { 0: "x" }, savedSnippetIds: {},
          chosenWordCategory: {}, chosenSnippetCategory: {},
          enrichments: { 0: { usage: "形容词，指视线或通道没有被阻挡、畅通无阻。易错点：不要与 unblocked 混用。",
            collocations: ["an unobstructed view of the sea —— 无遮挡的海景", "keep the exit unobstructed —— 保持出口畅通"],
            examples: ["The driving test requires an unobstructed view. —— 驾考要求视野无遮挡。"],
            etymology: "由 un-（否定前缀）+ obstruct（阻碍）+ -ed 构成。" } },
          enrichingIndices: [],
          categories: { forWords: [{ id: "c1", name: "英语", parentName: "语言学习" }], forSnippets: [] }
        };
        showPanel();
        panelSend("panel:state", fake);
        setTimeout(async () => {
          await shot(panelWindow, "shot-panel.png");
          app.exit(0);
        }, 1500);
      }, 3500);
    }

    // 每次启动做一次全量备份（保留最近 14 份）
    db.autoBackup();
    // 启动 8 秒后：灾难恢复（本地无已同步单词而 Anki 有卡 → 自动反向导入，新装机词库自动到位）
    setTimeout(async () => {
      if (!db.words().some(w => w.ankiNoteId)) {
        await anki.restoreFromAnki();
      }
      await audio.backfillAudio(db);
      await anki.syncEverythingPending();
      refreshMain();
    }, 8000);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* 常驻：热键取词不依赖窗口 */ });
}
