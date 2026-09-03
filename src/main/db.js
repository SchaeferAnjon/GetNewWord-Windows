// db.js — JSON 文件数据库（零原生依赖，词库量级几百条足够）
// 对应 macOS 版 SwiftData：words / contexts(内嵌) / snippets / categories
// 原子写：先写 .tmp 再 rename，防断电写坏

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('./applog');

const uuid = () => crypto.randomUUID();

const DB_FILE = () => path.join(app.getPath('userData'), 'db.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

let db = null;
let settings = null;
let saveTimer = null;
const listeners = new Set();

// ---------- 加载 / 保存 ----------

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE(), 'utf8'));
  } catch {
    db = { words: [], snippets: [], categories: [] };
  }
  db.words ||= []; db.snippets ||= []; db.categories ||= [];
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch {
    settings = {};
  }
  seedDefaultCategories();
  mergeDuplicateWords();
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { atomicWrite(DB_FILE(), db); } catch (e) { log(`[DB] save failed: ${e}`); }
  }, 150);
  for (const fn of listeners) fn();
}

function saveSettings() {
  try { atomicWrite(SETTINGS_FILE(), settings); } catch (e) { log(`[DB] settings save failed: ${e}`); }
}

function onChange(fn) { listeners.add(fn); }

// ---------- 设置 ----------

const SETTING_DEFAULTS = {
  apiProvider: 'zhipu',          // zhipu | deepseek
  zhipuKey: '', deepseekKey: '',
  thinkingEnabled: false, thinkingLevel: 'low',
  autoSpeak: true,
  appearance: 'system',          // system | light | dark
  fontScale: 1.0,
  hotkey: 'CommandOrControl+Shift+A',
  showFloatingButton: true,
  floatPos: null,
  hasOnboarded: false,
  screenshotQuality: 0.9
};

function getSetting(key) {
  return settings[key] !== undefined ? settings[key] : SETTING_DEFAULTS[key];
}
function setSetting(key, value) { settings[key] = value; saveSettings(); }
function allSettings() { return { ...SETTING_DEFAULTS, ...settings }; }

// ---------- 分类 ----------

function seedDefaultCategories() {
  if (db.categories.length > 0) return;
  const lang = { id: uuid(), name: '语言学习', icon: 'globe', parentId: null };
  const snip = { id: uuid(), name: '知识片段', icon: 'book', parentId: null };
  db.categories.push(
    lang, snip,
    { id: uuid(), name: '德语', icon: 'flag', parentId: lang.id },
    { id: uuid(), name: '英语', icon: 'flag', parentId: snip ? lang.id : lang.id },
    { id: uuid(), name: '健身', icon: 'folder', parentId: snip.id },
    { id: uuid(), name: '医学', icon: 'folder', parentId: snip.id },
    { id: uuid(), name: '其他', icon: 'folder', parentId: snip.id }
  );
  save();
}

const categories = () => db.categories;
const category = (id) => db.categories.find(c => c.id === id) || null;
const categoryByName = (name, parentName) => db.categories.find(c => {
  if (c.name !== name) return false;
  const p = category(c.parentId);
  return parentName ? p && p.name === parentName : true;
});
const rootCategory = (name) => db.categories.find(c => c.name === name && !c.parentId);

function leafCategories(forWords) {
  const parentName = forWords ? '语言学习' : '知识片段';
  return db.categories
    .filter(c => { const p = category(c.parentId); return p && p.name === parentName; })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function createCategory(name, forWords) {
  name = (name || '').trim();
  if (!name) return null;
  const parentName = forWords ? '语言学习' : '知识片段';
  const existing = categoryByName(name, parentName);
  if (existing) return existing;
  const parent = rootCategory(parentName);
  if (!parent) return null;
  const cat = { id: uuid(), name, icon: forWords ? 'flag' : 'folder', parentId: parent.id };
  db.categories.push(cat);
  save();
  log(`[Category] created '${parentName} > ${name}'`);
  return cat;
}

function renameCategory(id, name) {
  const cat = category(id); if (!cat) return;
  name = (name || '').trim();
  if (!name || name === cat.name) return;
  cat.name = name;
  // 里面的条目标记待同步 → 下次同步 changeDeck 搬牌组
  for (const w of db.words) if (w.categoryId === id) w.syncStatus = 'not_synced';
  for (const s of db.snippets) if (s.categoryId === id) s.syncStatus = 'not_synced';
  save();
  log(`[Category] renamed to '${name}'`);
}

function deleteCategory(id) {
  // 条目不删，回到未分组并标记待同步
  for (const w of db.words) if (w.categoryId === id) { w.categoryId = null; w.syncStatus = 'not_synced'; }
  for (const s of db.snippets) if (s.categoryId === id) { s.categoryId = null; s.syncStatus = 'not_synced'; }
  db.categories = db.categories.filter(c => c.id !== id && c.parentId !== id);
  save();
}

/// 分类树文本（给模型看）："语言学习 > 英语\n知识片段 > 健身"
function categoryTreeDescription() {
  return db.categories
    .filter(c => c.parentId)
    .map(c => `${category(c.parentId)?.name || ''} > ${c.name}`)
    .sort()
    .join('\n');
}

// ---------- 单词 ----------

const LANGUAGE_NAMES = { de: '德语', en: '英语', zh: '中文', fr: '法语', es: '西班牙语', ja: '日语', ko: '韩语', other: '其他' };
const languageDisplayName = (code) => LANGUAGE_NAMES[code] || code;

function matchLanguage(code) {
  const c = (code || '').toLowerCase();
  if (LANGUAGE_NAMES[c]) return c;
  const map = { german: 'de', deutsch: 'de', english: 'en', chinese: 'zh', french: 'fr', spanish: 'es', japanese: 'ja', korean: 'ko' };
  return map[c] || 'other';
}
const matchDifficulty = (raw) => ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].includes((raw || '').toLowerCase()) ? raw.toLowerCase() : 'b1';

const words = () => db.words;
const word = (id) => db.words.find(w => w.id === id) || null;
const snippets = () => db.snippets;
const snippet = (id) => db.snippets.find(s => s.id === id) || null;

const dedupeKey = (w) => `${(w.word || '').trim().toLowerCase()}|${w.language}`;

/// 两个语境句是否"几乎一样"：规范化相等或词元 Jaccard ≥ 0.8
function isSimilarSentence(a, b) {
  const norm = (s) => (s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const ta = norm(a), tb = norm(b);
  if (!ta.length || !tb.length) return a === b;
  if (ta.join(' ') === tb.join(' ')) return true;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.8;
}

/// 保存单词（同词同语言合并语境；相似语境去重）。返回 {entry, mergedContext, skippedAsDuplicate}
function saveWord(analysis, screenshotPath, categoryId) {
  const language = matchLanguage(analysis.language);
  const key = `${(analysis.word || '').trim().toLowerCase()}|${language}`;
  const now = new Date().toISOString();

  const existing = db.words.find(w => dedupeKey(w) === key);
  if (existing) {
    if ((existing.contexts || []).some(c => isSimilarSentence(c.sentence, analysis.contextSentence))) {
      log(`[Analysis] context for '${existing.word}' looks like an existing one, skipped`);
      if (!existing.grammar && analysis.grammar) existing.grammar = analysis.grammar;
      save();
      return { entry: existing, mergedContext: false, skippedAsDuplicate: true };
    }
    existing.contexts ||= [];
    existing.contexts.push({
      id: uuid(), sentence: analysis.contextSentence, translation: analysis.contextTranslation,
      note: analysis.analysisNote || '', screenshotPath, createdAt: now
    });
    if (!existing.phonetic && analysis.phonetic) existing.phonetic = analysis.phonetic;
    if (!existing.grammar && analysis.grammar) existing.grammar = analysis.grammar;
    if (!existing.etymology && analysis.etymology) existing.etymology = analysis.etymology;
    if (!existing.examplesText && analysis.examples?.length) existing.examplesText = analysis.examples.join('\n');
    existing.syncStatus = 'not_synced';
    save();
    log(`[Analysis] merged context into existing word '${existing.word}' (now ${existing.contexts.length} contexts)`);
    return { entry: existing, mergedContext: true, skippedAsDuplicate: false };
  }

  // 自动匹配分类：指定的 → 按语言找同名叶子分类
  let catId = categoryId || null;
  if (!catId) {
    const cat = categoryByName(languageDisplayName(language), '语言学习');
    if (cat) catId = cat.id;
  }

  const entry = {
    id: uuid(), word: analysis.word, phonetic: analysis.phonetic || '',
    language, meaning: analysis.meaning || '', contextMeaning: analysis.contextMeaning || '',
    contextSentence: analysis.contextSentence || '', contextTranslation: analysis.contextTranslation || '',
    analysisNote: analysis.analysisNote || '', grammar: analysis.grammar || '',
    translationKeyword: analysis.translationKeyword || '',
    collocationsText: '', examplesText: (analysis.examples || []).join('\n'),
    etymology: analysis.etymology || '', audioPath: null, screenshotPath,
    difficulty: matchDifficulty(analysis.difficulty), tags: [],
    createdAt: now, reviewCount: 0, ankiNoteId: null, syncStatus: 'not_synced', isArchived: false,
    categoryId: catId,
    contexts: [{
      id: uuid(), sentence: analysis.contextSentence, translation: analysis.contextTranslation,
      note: analysis.analysisNote || '', screenshotPath, createdAt: now
    }]
  };
  db.words.push(entry);
  save();
  return { entry, mergedContext: false, skippedAsDuplicate: false };
}

function saveSnippet(analysis, screenshotPath, categoryId) {
  let catId = categoryId || null;
  if (!catId) {
    const other = categoryByName('其他', '知识片段');
    if (other) catId = other.id;
  }
  const s = {
    id: uuid(), title: analysis.title, content: analysis.content,
    sourceContext: analysis.sourceContext || '', screenshotPath,
    tags: [], domain: analysis.domain || '', createdAt: new Date().toISOString(),
    isArchived: false, syncStatus: 'not_synced', ankiNoteId: null, categoryId: catId
  };
  db.snippets.push(s);
  save();
  return s;
}

function updateWord(id, patch) {
  const w = word(id); if (!w) return null;
  Object.assign(w, patch);
  save();
  return w;
}

function updateSnippet(id, patch) {
  const s = snippet(id); if (!s) return null;
  Object.assign(s, patch);
  save();
  return s;
}

function deleteWords(ids) {
  db.words = db.words.filter(w => !ids.includes(w.id));
  save();
}
function deleteSnippets(ids) {
  db.snippets = db.snippets.filter(s => !ids.includes(s.id));
  save();
}

/// 删除单词的一条语境
function deleteContext(wordId, contextId) {
  const w = word(wordId); if (!w) return;
  w.contexts = (w.contexts || []).filter(c => c.id !== contextId);
  if (w.contexts.length) {
    w.contextSentence = w.contexts[0].sentence;
    w.contextTranslation = w.contexts[0].translation;
  }
  save();
}

/// 启动时合并历史重复单词（同词同语言），保留最早，语境并入
function mergeDuplicateWords() {
  const groups = new Map();
  for (const w of db.words) {
    const key = dedupeKey(w);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  let merged = 0;
  for (const [, entries] of groups) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const keeper = entries[0];
    keeper.contexts ||= [];
    for (const dup of entries.slice(1)) {
      const sentences = new Set(keeper.contexts.map(c => c.sentence));
      for (const c of (dup.contexts || [])) {
        if (!sentences.has(c.sentence)) { keeper.contexts.push(c); sentences.add(c.sentence); }
      }
      if (!keeper.phonetic) keeper.phonetic = dup.phonetic;
      db.words = db.words.filter(w => w.id !== dup.id);
      merged++;
    }
  }
  if (merged > 0) { save(); log(`[DB] merged ${merged} duplicate word entries`); }
}

/// 灾难恢复用：以完整字段直接落库（syncStatus=synced，不再推回 Anki）
function insertRestoredWord(o) {
  const now = new Date().toISOString();
  db.words.push({
    id: uuid(), word: o.word, phonetic: o.phonetic || '', language: o.language || 'other',
    meaning: o.meaning || '', contextMeaning: o.contextMeaning || '',
    contextSentence: o.contextSentence || '', contextTranslation: o.contextTranslation || '',
    analysisNote: o.analysisNote || '', grammar: o.grammar || '',
    collocationsText: o.collocationsText || '', examplesText: o.examplesText || '',
    etymology: o.etymology || '', audioPath: null, screenshotPath: null,
    difficulty: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].includes(o.difficulty) ? o.difficulty : 'b1',
    tags: [], createdAt: now, reviewCount: 0, ankiNoteId: o.ankiNoteId || null,
    syncStatus: 'synced', isArchived: false, categoryId: o.categoryId || null,
    contexts: (o.contexts || []).map(c => ({ id: uuid(), sentence: c.sentence, translation: c.translation || '', note: '', screenshotPath: null, createdAt: now }))
  });
  save();
}
function insertRestoredSnippet(o) {
  db.snippets.push({
    id: uuid(), title: o.title, content: o.content || '', sourceContext: o.sourceContext || '',
    screenshotPath: null, tags: [], domain: o.domain || '', createdAt: new Date().toISOString(),
    isArchived: false, syncStatus: 'synced', ankiNoteId: o.ankiNoteId || null, categoryId: o.categoryId || null
  });
  save();
}

/// 启动全量备份：db.json 快照到 userData/backups，保留最近 14 份
function autoBackup() {
  try {
    if (!db.words.length && !db.snippets.length) return;
    const dir = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    atomicWrite(path.join(dir, `backup_${ts}.json`), db);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('backup_')).sort().reverse();
    for (const f of files.slice(14)) fs.unlinkSync(path.join(dir, f));
    log(`[Backup] ${db.words.length} words / ${db.snippets.length} snippets → backup_${ts}.json`);
  } catch (e) { log(`[Backup] failed: ${e.message}`); }
}

/// 灾难恢复用：以完整字段直接落库（syncStatus=synced，不再推回 Anki）
function insertRestoredWord(o) {
  const now = new Date().toISOString();
  db.words.push({
    id: uuid(), word: o.word, phonetic: o.phonetic || '', language: o.language || 'other',
    meaning: o.meaning || '', contextMeaning: o.contextMeaning || '',
    contextSentence: o.contextSentence || '', contextTranslation: o.contextTranslation || '',
    analysisNote: o.analysisNote || '', grammar: o.grammar || '',
    collocationsText: o.collocationsText || '', examplesText: o.examplesText || '',
    etymology: o.etymology || '', audioPath: null, screenshotPath: null,
    difficulty: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].includes(o.difficulty) ? o.difficulty : 'b1',
    tags: [], createdAt: now, reviewCount: 0, ankiNoteId: o.ankiNoteId || null,
    syncStatus: 'synced', isArchived: false, categoryId: o.categoryId || null,
    contexts: (o.contexts || []).map(c => ({ id: uuid(), sentence: c.sentence, translation: c.translation || '', note: '', screenshotPath: null, createdAt: now }))
  });
  save();
}
function insertRestoredSnippet(o) {
  db.snippets.push({
    id: uuid(), title: o.title, content: o.content || '', sourceContext: o.sourceContext || '',
    screenshotPath: null, tags: [], domain: o.domain || '', createdAt: new Date().toISOString(),
    isArchived: false, syncStatus: 'synced', ankiNoteId: o.ankiNoteId || null, categoryId: o.categoryId || null
  });
  save();
}

/// 启动全量备份：db.json 快照到 userData/backups，保留最近 14 份
function autoBackup() {
  try {
    if (!db.words.length && !db.snippets.length) return;
    const dir = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    atomicWrite(path.join(dir, `backup_${ts}.json`), db);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('backup_')).sort().reverse();
    for (const f of files.slice(14)) fs.unlinkSync(path.join(dir, f));
    log(`[Backup] ${db.words.length} words / ${db.snippets.length} snippets → backup_${ts}.json`);
  } catch (e) { log(`[Backup] failed: ${e.message}`); }
}

module.exports = {
  load, save, onChange, uuid, insertRestoredWord, insertRestoredSnippet, autoBackup, insertRestoredWord, insertRestoredSnippet, autoBackup,
  getSetting, setSetting, allSettings,
  categories, category, leafCategories, createCategory, renameCategory, deleteCategory,
  categoryTreeDescription, categoryByName, rootCategory,
  words, word, snippets, snippet, saveWord, saveSnippet, updateWord, updateSnippet,
  deleteWords, deleteSnippets, deleteContext, isSimilarSentence,
  languageDisplayName, matchLanguage
};
