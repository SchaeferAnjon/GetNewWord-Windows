// audio.js — 真人发音：有道 dictvoice（免费无 key），下载缓存到 userData/audio/
// 同一个词只下一次；Anki 同步直接用这份 mp3。拿不到时由渲染层用系统 TTS 现场朗读。

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('./applog');

function audioDir() {
  const dir = path.join(app.getPath('userData'), 'audio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pronunciationURL(text, language) {
  const q = encodeURIComponent(text);
  switch (language) {
    case 'en': return `https://dict.youdao.com/dictvoice?audio=${q}&type=2`;
    case 'de': return `https://dict.youdao.com/dictvoice?audio=${q}&le=de`;
    case 'fr': return `https://dict.youdao.com/dictvoice?audio=${q}&le=fr`;
    case 'es': return `https://dict.youdao.com/dictvoice?audio=${q}&le=es`;
    case 'ja': return `https://dict.youdao.com/dictvoice?audio=${q}&le=jap`;
    case 'ko': return `https://dict.youdao.com/dictvoice?audio=${q}&le=ko`;
    case 'zh': return `https://dict.youdao.com/dictvoice?audio=${q}&le=zh`;
    default: return null;
  }
}

function audioFilePath(text, language) {
  const safe = text.replace(/[/\\ ]/g, '_');
  return path.join(audioDir(), `${safe}_${language}.mp3`);
}

function cachedAudioPath(text, language) {
  const p = audioFilePath(text, language);
  return fs.existsSync(p) ? p : null;
}

/// 维基词典真人录音（Wikimedia Commons，母语者；德语覆盖极好）→ mp3 转码地址
async function commonsPronunciationURL(text, language) {
  const prefix = { de: 'De', fr: 'Fr', es: 'Es', en: 'En-us' }[language];
  if (!prefix) return null;
  try {
    const title = encodeURIComponent(`File:${prefix}-${text}.ogg`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url&titles=${title}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const json = await res.json();
    const page = Object.values(json?.query?.pages || {})[0];
    const url = page?.imageinfo?.[0]?.url;
    if (!url) return null;
    const clean = url.split('?')[0];
    const filename = clean.split('/').pop();
    return clean.replace('/commons/', '/commons/transcoded/') + `/${filename}.mp3`;
  } catch { return null; }
}

/// Google TTS 免费口（全语言在线兜底）
function googleTTSURL(text, language) {
  if (!language || language === 'other') return null;
  const tl = language === 'zh' ? 'zh-CN' : language;
  return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${tl}&client=tw-ob`;
}

async function downloadAudio(remote, localPath, label) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(remote, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    clearTimeout(timer);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('audio')) {
      log(`[Audio] ${new URL(remote).host} no audio for '${label}' (${res.status})`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return false;
    fs.writeFileSync(localPath, buf);
    log(`[Audio] cached '${label}' ${Math.round(buf.length / 1024)}KB ← ${new URL(remote).host}`);
    return true;
  } catch (e) {
    log(`[Audio] download failed '${label}': ${e.message}`);
    return false;
  }
}

/// Commons 全文搜索真人录音（兜住大小写变体、En-us-、Lingua Libre 等）
async function commonsSearchPronunciationURL(text, language) {
  const accepted = {
    de: ['de-', 'll-q188 '], en: ['en-us-', 'en-uk-', 'en-au-', 'en-', 'll-q1860 '],
    fr: ['fr-', 'll-q150 '], es: ['es-', 'll-q1321 ']
  }[language];
  if (!accepted) return null;
  try {
    const sr = encodeURIComponent(`intitle:"${text}" filetype:audio`);
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=8&srsearch=${sr}`);
    const json = await res.json();
    const needle = `-${text.toLowerCase()}.`;
    const hit = (json?.query?.search || []).map(r => r.title).find(t => {
      const lower = t.toLowerCase();
      if (!lower.includes(needle)) return false;
      const name = lower.replace('file:', '');
      return accepted.some(p => name.startsWith(p) || name.includes(p));
    });
    if (!hit) return null;
    const res2 = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url&titles=${encodeURIComponent(hit)}`);
    const j2 = await res2.json();
    const page = Object.values(j2?.query?.pages || {})[0];
    const url = page?.imageinfo?.[0]?.url;
    if (!url) return null;
    const clean = url.split('?')[0];
    const filename = clean.split('/').pop();
    return clean.replace('/commons/', '/commons/transcoded/') + `/${filename}.mp3`;
  } catch { return null; }
}

/// 缓存 → 真人源（有道单词/维基词典/Commons 搜索）→ Google TTS → 有道短语合成音；
/// 都失败返回 null（渲染层降级系统 TTS）
async function generateAudioFile(text, language) {
  const cached = cachedAudioPath(text, language);
  if (cached) return cached;
  const local = audioFilePath(text, language);
  const isPhrase = text.includes(' ');
  const youdao = pronunciationURL(text, language);
  if (!isPhrase && youdao && await downloadAudio(youdao, local, text)) return local;
  const commons = await commonsPronunciationURL(text, language);
  if (commons && await downloadAudio(commons, local, text)) return local;
  const search = await commonsSearchPronunciationURL(text, language);
  if (search && await downloadAudio(search, local, text)) return local;
  const gtts = googleTTSURL(text, language);
  if (gtts && await downloadAudio(gtts, local, text)) return local;
  if (isPhrase && youdao && await downloadAudio(youdao, local, text)) return local;
  return null;
}

/// 启动时给没有发音文件的旧单词补下载
async function backfillAudio(db) {
  const missing = db.words().filter(w => !w.audioPath || !fs.existsSync(w.audioPath));
  if (!missing.length) return;
  log(`[Audio] backfill ${missing.length} words`);
  for (const w of missing) {
    const p = await generateAudioFile(w.word, w.language);
    if (p) w.audioPath = p;
  }
  db.save();
}

module.exports = { generateAudioFile, cachedAudioPath, backfillAudio, audioDir };
