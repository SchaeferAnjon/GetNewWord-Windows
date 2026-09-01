// common.js — 渲染层公共工具（关键词高亮 / 释义强调 / 语言名 / 发音播放）

const LANG_NAMES = { de: '德语', en: '英语', zh: '中文', fr: '法语', es: '西班牙语', ja: '日语', ko: '韩语', other: '其他' };
const langName = (code) => LANG_NAMES[(code || '').toLowerCase()] || code || '';
const TTS_LOCALES = { de: 'de-DE', en: 'en-US', zh: 'zh-CN', fr: 'fr-FR', es: 'es-ES', ja: 'ja-JP', ko: 'ko-KR' };

const DIFF_CLASS = { a1: 'ok', a2: 'ok', b1: 'accent', b2: 'accent', c1: 'warn', c2: 'warn' };
const diffChip = (d) => `<span class="chip ${DIFF_CLASS[(d || '').toLowerCase()] || 'accent'}">${esc((d || '').toUpperCase())}</span>`;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/// 关键词高亮：整词（大小写不敏感）→ 找不到再按 ≥4 字符共同前缀匹配词形变化
function hlHTML(word, sentence) {
  const escaped = esc(sentence);
  const w = (word || '').trim();
  if (!w || w.length < 2) return escaped;
  try {
    const wholeRe = new RegExp(`(${escRe(w)})`, 'giu');
    if (wholeRe.test(escaped)) return escaped.replace(wholeRe, '<span class="kw">$1</span>');
    const stem = w.slice(0, Math.max(4, w.length - 2));
    if (stem.length < 4) return escaped;
    return escaped.replace(new RegExp(`\\b(${escRe(stem)}[\\p{L}]*)`, 'giu'), '<span class="kw">$1</span>');
  } catch { return escaped; }
}

/// 释义里强调当前语境义项
function emphasizeMeaningHTML(contextMeaning, meaning) {
  const m = esc(meaning);
  const cm = (contextMeaning || '').trim();
  if (!cm) return m;
  const cmEsc = esc(cm);
  if (!m.includes(cmEsc)) return m;
  return m.replace(cmEsc, `<span class="kw">${cmEsc}</span>`);
}

/// "外语原句 —— 中文" 拆两行
function exampleHTML(line, word) {
  const parts = line.split('——');
  const foreign = hlHTML(word, parts[0].trim());
  const zh = parts.length > 1 ? parts.slice(1).join('——').trim() : '';
  return `<div class="example"><div class="ex-foreign"><em>${foreign}</em></div>${zh ? `<div class="ex-zh">${esc(zh)}</div>` : ''}</div>`;
}

// ---------- 发音 ----------

let _audioEl = null;
function playAudioURL(url) {
  try {
    if (_audioEl) _audioEl.pause();
    _audioEl = new Audio(url);
    _audioEl.play().catch(() => {});
  } catch {}
}

function speakTTS(text, language) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const locale = TTS_LOCALES[language] || 'en-US';
    u.lang = locale;
    // 挑该语言下最好的系统语音
    const voices = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith(locale.slice(0, 2)));
    const exact = voices.find(v => v.lang.toLowerCase() === locale.toLowerCase());
    if (exact || voices[0]) u.voice = exact || voices[0];
    u.rate = 0.9;
    speechSynthesis.speak(u);
  } catch {}
}

/// 播放：先真人发音文件，没有降级 TTS
async function speakWord(text, language) {
  const url = await gnw.invoke('audio:path', text, language);
  if (url) playAudioURL(url);
  else speakTTS(text, language);
}

function fmtDate(iso, withTime) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const date = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  if (!withTime) return date;
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayGroupTitle(iso) {
  const d = new Date(iso), now = new Date();
  const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (sod(now) - sod(d)) / 86400000;
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return fmtDate(iso);
}

const SYNC_NAMES = { not_synced: '未同步', synced: '已同步', sync_failed: '同步失败', archived: '已归档' };
