// analysis.js — 分析流程状态机（移植 macOS 版 AnalysisViewModel）
// 取词模式：框选 → 面板立即弹出（骨架） → 三路并行（极速识词+发音 / 主分析 / 提前补全）
//          → 自动保存 → 后台补全 → Anki 同步。查词模式（lookup）：只看不入库，显式「保存」。

const db = require('./db');
const zhipu = require('./zhipu');
const anki = require('./anki');
const audio = require('./audio');
const capture = require('./capture');
const { log } = require('./applog');

let windows = null;   // 由 main.js 注入 { showPanel, hidePanel, panelSend, showError, refreshMain }

function init(w) { windows = w; }

// ---------- 状态 ----------

let S = null;

function freshState(mode) {
  return {
    mode,                       // 'capture' | 'lookup'
    analyzing: true,
    result: null,               // { words:[], snippets:[] }
    quickWord: null,            // { word, language }
    screenshotDataURL: null,
    autoSaved: false,
    selectedIndices: [],
    skippedAsDuplicate: [],
    removedWords: [], removedSnippets: [],
    savedWordIds: {}, savedSnippetIds: {},
    chosenWordCategory: {}, chosenSnippetCategory: {},
    enrichments: {}, enrichingIndices: [],
    categories: { forWords: [], forSnippets: [], byId: {} }
  };
}

let enrichStarted = false;

function pushState() {
  if (!S) return;
  S.categories = {
    forWords: db.leafCategories(true).map(c => ({ id: c.id, name: c.name, parentName: db.category(c.parentId)?.name || '' })),
    forSnippets: db.leafCategories(false).map(c => ({ id: c.id, name: c.name, parentName: db.category(c.parentId)?.name || '' }))
  };
  windows.panelSend('panel:state', S);
}

// ---------- 主流程 ----------

async function trigger(mode = 'capture') {
  if (S && S.analyzing) return;
  if (!zhipu.isConfigured()) {
    const msg = `未配置 ${zhipu.currentProviderName()} 的 API Key，请打开设置 → API 填写`;
    windows.showError(msg);
    return;
  }

  // 0. 框选（取消则静默退出）
  const cap = await capture.captureRegion();
  if (!cap) { return; }

  S = freshState(mode);
  enrichStarted = false;
  S.screenshotDataURL = cap.panelDataURL;

  // 1. 面板立刻弹出（骨架态）
  windows.showPanel();
  pushState();

  // 2. 并行：极速识词（出词头 + 发音 + 提前起跑补全）
  const myState = S;
  (async () => {
    try {
      const q = await zhipu.quickExtract(cap.quickDataURL);
      if (S !== myState || S.result) return;   // 主分析已回来/新一轮开始
      if (!q.word) { log('[Analysis] quick: 知识片段截图，跳过发音/预补全'); return; }
      S.quickWord = q;
      log(`[Analysis] quick word '${q.word}' (${q.language})`);
      pushState();
      if (db.getSetting('autoSpeak')) speak(q.word, db.matchLanguage(q.language));
      startEnrichment(q.word, q.language);
    } catch (e) { log(`[Analysis] quick failed: ${e.message}`); }
  })();

  // 3. 主分析
  try {
    let result = await zhipu.analyzeScreenshot(cap.apiDataURL, db.categoryTreeDescription());
    if (S !== myState) return;
    result = enforceExclusive(result);
    S.analyzing = false;

    // 快速识词是否认对了（词头一致）
    const first = result.words[0];
    const quickOK = !!(S.quickWord && first && first.word.toLowerCase() === S.quickWord.word.toLowerCase());
    if (enrichStarted && !quickOK) {
      enrichStarted = false;
      delete S.enrichments[0];
    }
    S.result = result;
    S.selectedIndices = result.words.map((_, i) => i);
    result.words.forEach((w, i) => {
      const cat = matchCategory(w.category, true);
      if (cat) S.chosenWordCategory[i] = cat.id;
    });
    result.snippets.forEach((s, i) => {
      const cat = matchCategory(s.category, false);
      if (cat) S.chosenSnippetCategory[i] = cat.id;
    });

    if (mode === 'capture') autoSave(cap.pngPath);
    pushState();
    log(`[Analysis] ✓ words=${result.words.length} snippets=${result.snippets.length} mode=${mode} autoSaved=${S.autoSaved}`);
    if (!quickOK && db.getSetting('autoSpeak') && first) speak(first.word, db.matchLanguage(first.language));
    enrichWordsInBackground();
  } catch (e) {
    if (S !== myState) return;
    S = null;
    windows.hidePanel();
    log(`[Analysis] ✗ ${e.message}`);
    windows.showError(e.message);
  }
}

/// 单词/知识片段二选一兜底（模型两个都给时）
function enforceExclusive(result) {
  if (!result.words.length || !result.snippets.length) return result;
  const keepWord = !!(S.quickWord && S.quickWord.word);
  log(`[Analysis] 模型同时返回单词+片段，兜底保留${keepWord ? '单词' : '片段'}`);
  return keepWord ? { words: result.words, snippets: [] } : { words: [], snippets: result.snippets };
}

function matchCategory(rawName, forWords) {
  if (!rawName) return null;
  const leaf = rawName.split('>').pop().trim();
  return db.leafCategories(forWords).find(c => c.name.toLowerCase() === leaf.toLowerCase()) || null;
}

// ---------- 发音 ----------

async function speak(text, language) {
  const p = await audio.generateAudioFile(text, language);
  windows.panelSend('play-audio', p ? { path: p } : { tts: { text, language } });
}

// ---------- 补全 ----------

function startEnrichment(word, language) {
  if (enrichStarted) return;
  enrichStarted = true;
  S.enrichingIndices = [0];
  pushState();
  const myState = S;
  (async () => {
    try {
      const e = await zhipu.enrichWord(word, language);
      // 面板可能已关（已保存态）：继续用快照写回；未保存关闭时 savedWordIds 为空、写回自动落空
      const first = myState.result?.words?.[0];
      if (myState.result && (!first || first.word.toLowerCase() !== word.toLowerCase())) {
        log(`[Analysis] pre-enrich '${word}' 丢弃（实际词头 '${first?.word || '-'}'）`);
      } else {
        myState.enrichments[0] = e;
        applyEnrichmentToSaved(myState, 0, e);
        if (myState.autoSaved) scheduleAnkiSync();
      }
    } catch (err) {
      log(`[Analysis] pre-enrich '${word}' failed: ${err.message}`);
      enrichStarted = false;
      if (myState.result && !myState.enrichments[0]) myState.enrichments[0] = { failed: true };   // 停掉加载圈
    }
    myState.enrichingIndices = myState.enrichingIndices.filter(i => i !== 0);
    if (S === myState) pushState();
  })();
}

function applyEnrichmentToSaved(state, i, e) {
  const id = state.savedWordIds[i];
  if (!id) return;
  const patch = {};
  if (e.usage) patch.analysisNote = e.usage;
  if (e.collocations?.length) patch.collocationsText = e.collocations.join('\n');
  if (e.examples?.length) patch.examplesText = e.examples.join('\n');
  if (e.etymology) patch.etymology = e.etymology;
  db.updateWord(id, patch);
  windows.refreshMain();
}

function enrichWordsInBackground() {
  const words = S.result?.words || [];
  if (!words.length) return;
  if (enrichStarted) {
    if (S.enrichments[0]) applyEnrichmentToSaved(S, 0, S.enrichments[0]);
    if (words.length === 1) {
      if (S.autoSaved && !S.enrichingIndices.length) scheduleAnkiSync();
      // 补全还在跑：跑完由 startEnrichment 收尾，这里挂一个延迟同步兜底
      if (S.enrichingIndices.length) waitEnrichThenSync();
      return;
    }
  }
  S.enrichingIndices = words.map((_, i) => i).filter(i => !(enrichStarted && i === 0));
  pushState();
  const myState = S;
  (async () => {
    for (let i = 0; i < words.length; i++) {
      if (enrichStarted && i === 0) continue;
      // 未保存且面板已关 → 取消；已保存 → 面板关了也跑完写回
      if (S !== myState && !myState.autoSaved) return;
      const w = words[i];
      try {
        const e = await zhipu.enrichWord(w.word, w.language, w.meaning, w.contextSentence);
        myState.enrichments[i] = e;
        applyEnrichmentToSaved(myState, i, e);
      } catch (err) {
        log(`[Analysis] enrich '${w.word}' failed: ${err.message}`);
        if (!myState.enrichments[i]) myState.enrichments[i] = { failed: true };   // 停掉加载圈
      }
      myState.enrichingIndices = myState.enrichingIndices.filter(x => x !== i);
      if (S === myState) pushState();
    }
    if (myState.autoSaved) scheduleAnkiSync();
  })();
}

function waitEnrichThenSync() {
  const myState = S;
  const timer = setInterval(() => {
    if (S !== myState) { clearInterval(timer); return; }
    if (!S.enrichingIndices.length) {
      clearInterval(timer);
      if (S.autoSaved) scheduleAnkiSync();
    }
  }, 800);
  setTimeout(() => clearInterval(timer), 60000);
}

// ---------- 自动保存 / 撤销 / 单项移除 ----------

function autoSave(pngPath) {
  try {
    (S.result.words || []).forEach((w, i) => {
      const catId = S.chosenWordCategory[i] || null;
      const { entry, skippedAsDuplicate } = db.saveWord(w, pngPath, catId);
      if (skippedAsDuplicate) S.skippedAsDuplicate.push(i);
      S.savedWordIds[i] = entry.id;
      if (!S.chosenWordCategory[i] && entry.categoryId) S.chosenWordCategory[i] = entry.categoryId;
      // 预下载发音
      audio.generateAudioFile(entry.word, entry.language).then(p => { if (p) db.updateWord(entry.id, { audioPath: p }); });
    });
    (S.result.snippets || []).forEach((sn, i) => {
      const catId = S.chosenSnippetCategory[i] || null;
      const s = db.saveSnippet(sn, pngPath, catId);
      S.savedSnippetIds[i] = s.id;
      if (!S.chosenSnippetCategory[i] && s.categoryId) S.chosenSnippetCategory[i] = s.categoryId;
    });
    S.autoSaved = true;
    if (!(S.result.words || []).length) scheduleAnkiSync();   // 只有片段：直接同步
    windows.refreshMain();
  } catch (e) {
    log(`[Analysis] ✗ autosave: ${e.message}`);
  }
}

function undoAutoSave() {
  if (!S || !S.autoSaved) return;
  const cutoff = Date.now() - 120000;
  const wordIds = [], ctxRemovals = [];
  for (const id of Object.values(S.savedWordIds)) {
    const w = db.word(id);
    if (!w) continue;
    if (new Date(w.createdAt).getTime() > cutoff) wordIds.push(id);
    else {
      const newest = (w.contexts || [])[w.contexts.length - 1];
      if (newest && new Date(newest.createdAt).getTime() > cutoff && w.contexts.length > 1) {
        ctxRemovals.push([id, newest.id]);
      }
    }
  }
  db.deleteWords(wordIds);
  for (const [wid, cid] of ctxRemovals) db.deleteContext(wid, cid);
  const snippetIds = Object.values(S.savedSnippetIds).filter(id => {
    const s = db.snippet(id);
    return s && new Date(s.createdAt).getTime() > cutoff;
  });
  db.deleteSnippets(snippetIds);
  log(`[Analysis] undo autosave: ${wordIds.length} words, ${snippetIds.length} snippets`);
  // 面板留着，切到「未保存」状态
  S.savedWordIds = {}; S.savedSnippetIds = {};
  S.skippedAsDuplicate = []; S.removedWords = []; S.removedSnippets = [];
  S.autoSaved = false;
  S.selectedIndices = (S.result?.words || []).map((_, i) => i);
  pushState();
  windows.refreshMain();
}

function removeSavedWord(index) {
  if (!S) return;
  const id = S.savedWordIds[index];
  if (id) {
    const w = db.word(id);
    if (w) {
      const cutoff = Date.now() - 300000;
      if (new Date(w.createdAt).getTime() > cutoff) {
        if (w.ankiNoteId) anki.deleteAnkiNotes([w.ankiNoteId]);   // 保持 Anki 同步
        db.deleteWords([id]);
      } else {
        const newest = (w.contexts || [])[w.contexts.length - 1];
        if (newest && new Date(newest.createdAt).getTime() > cutoff && w.contexts.length > 1) {
          db.deleteContext(id, newest.id);
          db.updateWord(id, { syncStatus: 'not_synced' });
          scheduleAnkiSync();
        }
      }
    }
    delete S.savedWordIds[index];
  }
  S.removedWords.push(index);
  pushState();
  windows.refreshMain();
}

function removeSavedSnippet(index) {
  if (!S) return;
  const id = S.savedSnippetIds[index];
  if (id) {
    const s = db.snippet(id);
    if (s) anki.deleteSnippetNote(s.ankiNoteId, s.title);   // 保持 Anki 同步
    db.deleteSnippets([id]);
    delete S.savedSnippetIds[index];
  }
  S.removedSnippets.push(index);
  pushState();
  windows.refreshMain();
}

// ---------- 分类 ----------

function setCategory(forWords, index, categoryId) {
  if (!S) return;
  const chosen = forWords ? S.chosenWordCategory : S.chosenSnippetCategory;
  if (categoryId) chosen[index] = categoryId; else delete chosen[index];
  const savedId = (forWords ? S.savedWordIds : S.savedSnippetIds)[index];
  if (savedId) {
    (forWords ? db.updateWord : db.updateSnippet)(savedId, { categoryId: categoryId || null, syncStatus: 'not_synced' });
    windows.refreshMain();
  }
  pushState();
}

function createCategoryAndAssign(forWords, index, name) {
  const cat = db.createCategory(name, forWords);
  if (cat) setCategory(forWords, index, cat.id);
  return cat;
}

// ---------- 查词模式显式保存 ----------

function saveSelected(pngPath) {
  if (!S || !S.result) return;
  (S.result.words || []).forEach((w, i) => {
    if (!S.selectedIndices.includes(i)) return;
    const { entry } = db.saveWord(w, null, S.chosenWordCategory[i] || null);
    S.savedWordIds[i] = entry.id;
    audio.generateAudioFile(entry.word, entry.language).then(p => { if (p) db.updateWord(entry.id, { audioPath: p }); });
  });
  (S.result.snippets || []).forEach((sn, i) => {
    if (S.removedSnippets.includes(i)) return;
    const s = db.saveSnippet(sn, null, S.chosenSnippetCategory[i] || null);
    S.savedSnippetIds[i] = s.id;
  });
  S.autoSaved = true;
  scheduleAnkiSync();
  dismiss();
  windows.refreshMain();
}

function toggleSelection(index) {
  if (!S) return;
  if (S.selectedIndices.includes(index)) S.selectedIndices = S.selectedIndices.filter(i => i !== index);
  else S.selectedIndices.push(index);
  pushState();
}

// ---------- Anki 同步调度 ----------

let syncTimer = null;
function scheduleAnkiSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    await anki.syncEverythingPending();
    windows.refreshMain();
  }, 1500);   // 给撤销留一点时间，也等发音下载
}

function dismiss() {
  S = null;
  windows.hidePanel();
}

function getState() { return S; }

module.exports = {
  init, trigger, dismiss, getState, pushState,
  undoAutoSave, removeSavedWord, removeSavedSnippet,
  setCategory, createCategoryAndAssign, saveSelected, toggleSelection,
  scheduleAnkiSync, speak
};
