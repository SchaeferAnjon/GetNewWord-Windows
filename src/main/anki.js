// anki.js — AnkiConnect 集成（http://127.0.0.1:8765），逐函数移植 macOS 版 AnkiService.swift
// 牌组 = 分类树路径；卡片模板与 app UI 同风格（关键词高亮 .kw）；媒体文件名全小写（AnkiWeb 大小写敏感）

const fs = require('fs');
const db = require('./db');
const audio = require('./audio');
const { log } = require('./applog');

const BASE_URL = 'http://127.0.0.1:8765';
const MODEL_NAME = 'GetNewWord';
const SNIPPET_MODEL_NAME = 'GetNewWord Snippet';

async function send(action, params) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ? { action, version: 6, params } : { action, version: 6 })
  });
  if (!res.ok) throw new Error(`Anki HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) { log(`[Anki] ${action} error: ${json.error}`); throw new Error(json.error); }
  return json.result;
}

async function isAnkiRunning() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(BASE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'version', version: 6 }), signal: ctrl.signal
    });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

// ---------- 牌组 ----------

async function deckNames() {
  const names = await send('deckNames');
  return names.filter(n => n !== 'Default');
}

async function ensureDeckExists(name) {
  const existing = await deckNames();
  if (!existing.includes(name)) await send('createDeck', { deck: name });
}

function deckNameForWord(w) {
  const cat = db.category(w.categoryId);
  if (cat) {
    const parent = db.category(cat.parentId);
    return parent ? `${parent.name}::${cat.name}` : cat.name;
  }
  return `语言学习::${db.languageDisplayName(w.language)}`;
}

function deckNameForSnippet(s) {
  const cat = db.category(s.categoryId);
  if (cat) {
    const parent = db.category(cat.parentId);
    return parent ? `${parent.name}::${cat.name}` : cat.name;
  }
  return '知识片段::其他';
}

// ---------- 关键词高亮 / 卡片 HTML（与 macOS 版一致） ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/// 大小写不敏感整词 + ≥4 字符共同前缀词形变化 → <span class="kw">
function hl(text, word) {
  const w = (word || '').trim();
  if (!w || w.length < 2 || !text) return text || '';
  let pattern = escapeRe(w);
  if (w.length >= 4) {
    const stem = escapeRe(w.slice(0, Math.max(4, w.length - 2)));
    pattern = `${pattern}|${stem}[\\p{L}]*`;
  }
  try {
    return text.replace(new RegExp(`(${pattern})`, 'giu'), '<span class="kw">$1</span>');
  } catch { return text; }
}

/// 中文译文里高亮语境义项；整串没命中就拆子义项
function hlSense(text, sense, keyword) {
  const k = (keyword || '').trim();
  if (k && text && text.includes(k)) return text.replace(k, `<span class="kw">${k}</span>`);
  const s = (sense || '').trim();
  if (!s || !text) return text || '';
  if (text.includes(s)) return text.replace(s, `<span class="kw">${s}</span>`);
  let out = text;
  for (const p of s.split(/[，,、；;／/ ]+/)) {
    const t = p.trim();
    if (t && out.includes(t) && !out.includes(`<span class="kw">${t}`)) {
      out = out.replace(t, `<span class="kw">${t}</span>`);
    }
  }
  return out;
}

/// Back 字段：整个义项列表，当前语境义项加粗标色
function emphasizedMeaningHTML(w) {
  const cm = w.contextMeaning;
  if (!cm || !w.meaning.includes(cm)) return w.meaning;
  return w.meaning.replace(cm, `<b style="color:#5E6AD2">${cm}</b>`);
}

/// 卡片背面「AI 解释」：用法 + 搭配 + 例句 + 词根词源
function composeAnalysisHTML(w) {
  const parts = [];
  const line = (raw) => {
    const comps = raw.split('——');
    const foreign = hl(comps[0].trim(), w.word);
    if (comps.length > 1) {
      const zh = comps.slice(1).join('——').trim();
      return `<div class="ctx">${foreign}<div class="zh">${zh}</div></div>`;
    }
    return `<div class="ctx">${foreign}</div>`;
  };
  if (w.analysisNote) parts.push(`<div class="lbl">用 法</div><div class="usage">${hl(w.analysisNote, w.word)}</div>`);
  if (w.collocationsText) parts.push(`<div class="lbl">搭 配</div><div class="sec">${w.collocationsText.split('\n').map(line).join('')}</div>`);
  if (w.examplesText) parts.push(`<div class="lbl">例 句</div><div class="sec">${w.examplesText.split('\n').map(line).join('')}</div>`);
  if (w.etymology) parts.push(`<div class="lbl">词根词源</div><div class="sec">${w.etymology}</div>`);
  return parts.join('');
}

// ---------- 模板 ----------

const CARD_CSS = `
.card { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; font-size: 17px; color: #18191C; background: #FAFAFB; padding: 24px 20px; text-align: left; line-height: 1.55; }
.word { font-size: 30px; font-weight: 700; }
.phon { font-family: Consolas, Menlo, monospace; font-size: 14px; color: #5F636C; margin-top: 2px; }
.gram { font-family: Consolas, Menlo, monospace; font-size: 13px; color: #5E6AD2; font-weight: 600; margin-top: 4px; }
.meta { font-size: 12px; color: #969AA2; margin-top: 4px; }
.meaning { font-size: 19px; margin: 10px 0 4px; }
.lbl { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #969AA2; margin: 16px 0 6px; }
.ctxbox { border-left: 2.5px solid rgba(94,106,210,.7); padding: 2px 0 2px 12px; margin: 6px 0; }
.ctx { font-style: italic; margin: 4px 0; }
.ctx-tr, .zh { font-style: normal; font-size: 14px; color: #5F636C; margin-top: 1px; }
.usage { font-size: 15px; color: inherit; line-height: 1.6; }
.sec { font-size: 15px; }
.kw { color: #5E6AD2; font-weight: 700; }
img { max-width: 100%; border-radius: 8px; margin-top: 8px; }
hr { border: none; border-top: .5px solid rgba(0,0,0,.12); margin: 14px 0; }
.nightMode .card, .night_mode .card { color: #EDEDEF; background: #161A1E; }
.nightMode .usage, .night_mode .usage { color: inherit; }
`;

async function modelNames() { return send('modelNames'); }

async function createModel() {
  const front = `<div class="word">{{Front}}</div><div class="phon">{{Phonetic}}</div><div class="gram">{{Grammar}}</div><div class="meta">{{Language}} · {{Difficulty}}</div><div>{{Audio}}</div>`;
  const back = `{{FrontSide}}<hr><div class="meaning">{{Back}}</div><div class="lbl">语 境</div><div class="ctxbox">{{Context}}{{ContextTranslation}}</div>{{Analysis}}<div style="margin-top:12px">{{Screenshot}}</div>`;
  await send('createModel', {
    modelName: MODEL_NAME,
    inOrderFields: ['Front', 'Back', 'Phonetic', 'Context', 'ContextTranslation', 'Analysis', 'Screenshot', 'Language', 'Difficulty', 'Audio', 'Grammar'],
    css: CARD_CSS,
    isCloze: false,
    cardTemplates: [{ Name: '正面', Front: front, Back: back }]
  });
}

async function ensureModelExists() {
  const existing = await modelNames();
  if (!existing.includes(MODEL_NAME)) await createModel();
  // 已存在的模板不做自动改动（改模板 = 强制全量同步，会与手机复习记录冲突）
}

async function ensureSnippetModelExists() {
  const existing = await modelNames();
  if (existing.includes(SNIPPET_MODEL_NAME)) return;
  await send('createModel', {
    modelName: SNIPPET_MODEL_NAME,
    inOrderFields: ['Title', 'Content', 'Source', 'Domain', 'Screenshot'],
    css: `.card { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; font-size: 16px; color: #333; background: #fff; padding: 20px; text-align: left; }
.title { font-size: 22px; font-weight: 700; text-align: center; }
.domain { font-size: 12px; color: #888; text-align: center; margin-top: 6px; }
.content { margin-top: 14px; line-height: 1.5; white-space: pre-wrap; }
.source { margin-top: 12px; padding: 10px; background: #f3f3f3; border-radius: 6px; font-size: 13px; color: #666; font-style: italic; }`,
    isCloze: false,
    cardTemplates: [{
      Name: '知识',
      Front: `<div class="title">{{Title}}</div><div class="domain">{{Domain}}</div>`,
      Back: `{{FrontSide}}<hr><div class="content">{{Content}}</div>{{#Source}}<div class="source">{{Source}}</div>{{/Source}}<div style="margin-top:10px">{{Screenshot}}</div>`
    }]
  });
}

// ---------- 笔记 CRUD ----------

async function addNote(deckName, modelName, fields, tags) {
  return send('addNote', {
    note: {
      deckName, modelName, fields, tags,
      options: { allowDuplicate: false, duplicateScope: 'deck', duplicateScopeOptions: { deckName, checkChildren: true } }
    }
  });
}

const updateNoteFields = (noteId, fields) => send('updateNoteFields', { note: { id: noteId, fields } });
const findNotes = (query) => send('findNotes', { query });
const deleteNotes = (noteIds) => send('deleteNotes', { notes: noteIds });
const storeMedia = (filename, base64) => send('storeMediaFile', { filename, data: base64 });

async function moveNote(noteId, deck) {
  const cards = await send('findCards', { query: `nid:${noteId}` });
  if (cards.length) await send('changeDeck', { cards, deck });
}

/// 按 noteId 批量删卡（Anki 没开就静默跳过）
async function deleteAnkiNotes(ids) {
  if (!ids || !ids.length) return;
  if (!await isAnkiRunning()) { log(`[Anki] not running, cannot delete ${ids.length} notes`); return; }
  try { await deleteNotes(ids); log(`[Anki] deleted ${ids.length} note(s)`); } catch {}
}

/// 删除片段卡：有 noteId 用 noteId，回退按标题查
async function deleteSnippetNote(noteId, title) {
  if (noteId) return deleteAnkiNotes([noteId]);
  if (!await isAnkiRunning()) return;
  const clean = (title || '').replace(/"/g, '');
  try {
    const notes = await findNotes(`"note:${SNIPPET_MODEL_NAME}" "Title:${clean}"`);
    if (notes.length) { await deleteNotes(notes); log(`[Anki] deleted ${notes.length} snippet note(s) titled '${title}'`); }
  } catch {}
}

// ---------- 同步 ----------

async function syncWord(w) {
  const deckName = deckNameForWord(w);
  try { await ensureDeckExists(deckName); } catch {
    const parts = deckName.split('::');
    if (parts.length > 1) { try { await ensureDeckExists(parts[0]); await ensureDeckExists(deckName); } catch {} }
  }

  const contexts = w.contexts || [];
  const contextHTML = contexts.map(c => `<div class="ctx">${hl(c.sentence, w.word)}</div>`).join('');
  const translationHTML = contexts.map(c => `<div class="ctx-tr">${hlSense(c.translation, w.contextMeaning, w.translationKeyword)}</div>`).join('');

  const fields = {
    Front: w.word,
    Back: emphasizedMeaningHTML(w),
    Phonetic: w.phonetic || '',
    Context: contextHTML || hl(w.contextSentence, w.word),
    ContextTranslation: translationHTML || hlSense(w.contextTranslation, w.contextMeaning, w.translationKeyword) || '',
    Analysis: composeAnalysisHTML(w),
    Screenshot: '',
    Language: db.languageDisplayName(w.language),
    Difficulty: (w.difficulty || '').toUpperCase(),
    Audio: '',
    Grammar: w.grammar || ''
  };

  // 发音：优先缓存 mp3，没有就现下；文件名全小写（AnkiWeb 大小写敏感）
  let audioPath = w.audioPath;
  if (!audioPath || !fs.existsSync(audioPath)) {
    audioPath = await audio.generateAudioFile(w.word, w.language);
    if (audioPath) w.audioPath = audioPath;
  }
  if (audioPath && fs.existsSync(audioPath)) {
    const ext = audioPath.split('.').pop();
    const filename = `gnw_${w.id.toLowerCase()}.${ext}`;
    try {
      await storeMedia(filename, fs.readFileSync(audioPath).toString('base64'));
      fields.Audio = `[sound:${filename}]`;
    } catch {}
  }

  // 截图
  if (w.screenshotPath && fs.existsSync(w.screenshotPath)) {
    const filename = `gnw_img_${w.id.toLowerCase()}.png`;
    try {
      await storeMedia(filename, fs.readFileSync(w.screenshotPath).toString('base64'));
      fields.Screenshot = `<img src="${filename}">`;
    } catch {}
  }

  // 没拿到本地音频/截图：不带字段，updateNoteFields 不会覆盖 Anki 卡上已有内容
  if (fields.Audio === '') delete fields.Audio;
  if (fields.Screenshot === '') delete fields.Screenshot;

  const tags = ['GetNewWord', `lang:${w.language}`];

  if (w.ankiNoteId) {
    try {
      await updateNoteFields(w.ankiNoteId, fields);
      try { await moveNote(w.ankiNoteId, deckName); } catch {}
      w.syncStatus = 'synced';
    } catch (e) { w.syncStatus = 'sync_failed'; throw e; }
  } else {
    try {
      const noteId = await addNote(deckName, MODEL_NAME, fields, tags);
      w.ankiNoteId = noteId;
      w.syncStatus = 'synced';
      log(`[Anki] ✓ added '${w.word}' → ${deckName} (note ${noteId})`);
    } catch (e) { w.syncStatus = 'sync_failed'; throw e; }
  }
  db.save();
}

async function syncSnippet(s) {
  const deckName = deckNameForSnippet(s);
  try { await ensureDeckExists(deckName); } catch {}
  const fields = {
    Title: s.title,
    Content: (s.content || '').replace(/\n/g, '<br>'),
    Source: s.sourceContext || '',
    Domain: db.category(s.categoryId)?.name || s.domain || '未分组',
    Screenshot: ''
  };
  if (s.screenshotPath && fs.existsSync(s.screenshotPath)) {
    const filename = `gnw_snip_${s.id.toLowerCase()}.png`;
    try {
      await storeMedia(filename, fs.readFileSync(s.screenshotPath).toString('base64'));
      fields.Screenshot = `<img src="${filename}">`;
    } catch {}
  }
  if (fields.Screenshot === '') delete fields.Screenshot;   // 没有本地截图不覆盖 Anki 已有的
  // 优先用已存的 noteId；老数据按 Title 查一次并回填
  let noteId = s.ankiNoteId;
  if (!noteId) {
    try {
      const found = await findNotes(`"note:${SNIPPET_MODEL_NAME}" "Title:${(s.title || '').replace(/"/g, '')}"`);
      noteId = found[0] || null;
    } catch {}
  }
  if (noteId) {
    await updateNoteFields(noteId, fields);
    try { await moveNote(noteId, deckName); } catch {}
    s.ankiNoteId = noteId;
  } else {
    const newId = await addNote(deckName, SNIPPET_MODEL_NAME, fields, ['GetNewWord', 'snippet']);
    s.ankiNoteId = newId;
    log(`[Anki] ✓ added snippet '${s.title}' → ${deckName} (note ${newId})`);
  }
  s.syncStatus = 'synced';
  db.save();
}

/// 反向同步：Anki 里删掉的卡（notesInfo 返回空对象）→ 本地也删
async function pruneDeleted() {
  const check = async (items, label) => {
    const withId = items.filter(x => x.ankiNoteId);
    if (!withId.length) return [];
    const ids = withId.map(x => x.ankiNoteId);
    let infos;
    try { infos = await send('notesInfo', { notes: ids }); } catch { return []; }
    if (!Array.isArray(infos) || infos.length !== ids.length) return [];
    // 熔断：绝大多数本地卡都"在 Anki 不存在" = 换库/换配置/新账号，绝不能当成用户删卡
    const missing = infos.filter(i => !i || i.noteId == null).length;
    if (missing > 2 && missing * 5 >= ids.length * 4) {
      log(`[Anki] 熔断：${missing}/${ids.length} 本地卡在 Anki 中不存在，疑似换库，跳过反向清理`);
      return [];
    }
    const gone = [];
    infos.forEach((info, i) => {
      if (!info || info.noteId == null) {
        const item = withId[i];
        log(`[Anki] ${label} '${item.word || item.title}' deleted in Anki → remove locally`);
        gone.push(item.id);
      }
    });
    return gone;
  };
  const goneWords = await check(db.words(), 'word');
  if (goneWords.length) db.deleteWords(goneWords);
  const goneSnippets = await check(db.snippets(), '片段');
  if (goneSnippets.length) db.deleteSnippets(goneSnippets);
}

/// 保存后自动调用：Anki 没开就静默跳过；同步所有未同步条目，推完触发增量 AnkiWeb 同步
async function syncEverythingPending() {
  if (!await isAnkiRunning()) { log('[Anki] not running, skip auto sync'); return { skipped: true }; }
  await pruneDeleted();
  const pendingWords = db.words().filter(w => w.syncStatus === 'not_synced' || w.syncStatus === 'sync_failed');
  const pendingSnippets = db.snippets().filter(s => s.syncStatus === 'not_synced' || s.syncStatus === 'sync_failed');
  if (pendingWords.length) {
    log(`[Anki] sync start: ${pendingWords.length} pending`);
    try { await ensureModelExists(); } catch (e) { log(`[Anki] ✗ 初始化失败: ${e.message}`); return { error: e.message }; }
    for (const w of pendingWords) {
      try { await syncWord(w); } catch (e) { log(`[Anki] ✗ 同步失败 [${w.word}]: ${e.message}`); }
    }
  }
  if (pendingSnippets.length) {
    try {
      await ensureSnippetModelExists();
      for (const s of pendingSnippets) {
        try { await syncSnippet(s); } catch (e) { s.syncStatus = 'sync_failed'; log(`[Anki] ✗ snippet '${s.title}': ${e.message}`); }
      }
      db.save();
    } catch (e) { log(`[Anki] ✗ snippet model: ${e.message}`); }
  }
  if (pendingWords.length || pendingSnippets.length) {
    try { await send('sync'); log('[Anki] triggered AnkiWeb sync'); }
    catch (e) { log(`[Anki] ✗ AnkiWeb sync trigger: ${e.message}`); }
  }
  return { synced: pendingWords.length + pendingSnippets.length };
}

// ---------- 灾难恢复：从 Anki 反向导入词库 ----------

function stripHTML(s) {
  return (s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}
function divContents(html, cls) {
  const re = new RegExp(`<div class="${cls}">(.*?)</div>`, 'gs');
  const out = []; let m;
  while ((m = re.exec(html || ''))) out.push(stripHTML(m[1]));
  return out;
}
function parseAnalysisHTML(html) {
  const r = {};
  for (const part of (html || '').split('<div class="lbl">').slice(1)) {
    const i = part.indexOf('</div>');
    if (i < 0) continue;
    const label = part.slice(0, i).replace(/\s/g, '');
    const body = part.slice(i + 6);
    const lines = (b) => b.split('<div class="ctx">').slice(1).map(entry => {
      const sub = entry.split('<div class="zh">');
      const foreign = stripHTML(sub[0]);
      const zh = sub.length > 1 ? stripHTML(sub[1]) : '';
      return zh ? `${foreign} —— ${zh}` : foreign;
    }).join('\n');
    if (label === '用法') r.usage = stripHTML(body);
    else if (label === '搭配') r.coll = lines(body);
    else if (label === '例句') r.ex = lines(body);
    else if (label === '词根词源') r.ety = stripHTML(body);
  }
  return r;
}
const LANG_FROM_DISPLAY = { 德语: 'de', 英语: 'en', 中文: 'zh', 法语: 'fr', 西班牙语: 'es', 日语: 'ja', 韩语: 'ko' };

/// 从 Anki 反向导入（幂等：同 noteId / 同词跳过）。新装机时自动把词库拉回来。
async function restoreFromAnki() {
  if (!await isAnkiRunning()) return 0;
  const localNoteIds = new Set(db.words().map(w => w.ankiNoteId).filter(Boolean));
  const localKeys = new Set(db.words().map(w => `${w.word.toLowerCase()}|${w.language}`));
  const noteDeckLeaf = new Map();
  try {
    for (const d of await deckNames()) {
      const leaf = d.split('::').pop();
      for (const m of [MODEL_NAME, SNIPPET_MODEL_NAME]) {
        for (const id of await findNotes(`"deck:${d}" "note:${m}"`)) noteDeckLeaf.set(id, leaf);
      }
    }
  } catch {}
  const catFor = (leaf, forWords) => {
    if (!leaf) return null;
    const found = db.categories().find(c => c.name === leaf && c.parentId);
    if (found) return found.id;
    const created = db.createCategory(leaf, forWords);
    return created ? created.id : null;
  };
  let restored = 0;
  try {
    const ids = await findNotes(`note:${MODEL_NAME}`);
    if (ids.length) {
      for (const info of await send('notesInfo', { notes: ids })) {
        if (!info || info.noteId == null || localNoteIds.has(info.noteId)) continue;
        const f = (k) => info.fields?.[k]?.value || '';
        const word = stripHTML(f('Front'));
        if (!word) continue;
        const language = LANG_FROM_DISPLAY[f('Language')] || 'other';
        const key = `${word.toLowerCase()}|${language}`;
        if (localKeys.has(key)) continue;
        localKeys.add(key);
        const back = f('Back');
        const cm = back.match(/<b[^>]*>([\s\S]*?)<\/b>/);
        let sentences = divContents(f('Context'), 'ctx');
        if (!sentences.length) { const s = stripHTML(f('Context')); if (s) sentences = [s]; }
        let translations = divContents(f('ContextTranslation'), 'ctx-tr');
        if (!translations.length) { const t = stripHTML(f('ContextTranslation')); if (t) translations = [t]; }
        const a = parseAnalysisHTML(f('Analysis'));
        db.insertRestoredWord({
          word, phonetic: stripHTML(f('Phonetic')), language,
          meaning: stripHTML(back), contextMeaning: cm ? stripHTML(cm[1]) : '',
          contextSentence: sentences[0] || '', contextTranslation: translations[0] || '',
          analysisNote: a.usage || '', grammar: stripHTML(f('Grammar')),
          collocationsText: a.coll || '', examplesText: a.ex || '', etymology: a.ety || '',
          difficulty: (f('Difficulty') || 'b1').toLowerCase(),
          ankiNoteId: info.noteId,
          categoryId: catFor(noteDeckLeaf.get(info.noteId), true),
          contexts: sentences.map((s, i) => ({ sentence: s, translation: translations[i] || '' }))
        });
        restored++;
      }
    }
    const sids = await findNotes(`"note:${SNIPPET_MODEL_NAME}"`);
    if (sids.length) {
      const localSnippetIds = new Set(db.snippets().map(s => s.ankiNoteId).filter(Boolean));
      const localTitles = new Set(db.snippets().map(s => s.title));
      for (const info of await send('notesInfo', { notes: sids })) {
        if (!info || info.noteId == null || localSnippetIds.has(info.noteId)) continue;
        const f = (k) => info.fields?.[k]?.value || '';
        const title = stripHTML(f('Title'));
        if (!title || localTitles.has(title)) continue;
        localTitles.add(title);
        db.insertRestoredSnippet({
          title, content: stripHTML(f('Content')), sourceContext: stripHTML(f('Source')),
          domain: stripHTML(f('Domain')), ankiNoteId: info.noteId,
          categoryId: catFor(noteDeckLeaf.get(info.noteId), false) || catFor(stripHTML(f('Domain')), false)
        });
        restored++;
      }
    }
  } catch (e) { log(`[Recovery] restore failed: ${e.message}`); }
  if (restored) log(`[Recovery] restored ${restored} items from Anki`);
  return restored;
}

module.exports = {
  isAnkiRunning, deckNames, syncEverythingPending, syncWord, restoreFromAnki,
  deleteAnkiNotes, deleteSnippetNote, deckNameForWord, deckNameForSnippet, hl
};
