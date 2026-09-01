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

/// 下载真人发音并缓存；失败返回 null（短语/冷门词有道会 500）
async function downloadPronunciation(text, language) {
  const url = pronunciationURL(text, language);
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('audio')) {
      log(`[Audio] youdao no audio for '${text}' (${res.status})`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return null;
    const p = audioFilePath(text, language);
    fs.writeFileSync(p, buf);
    log(`[Audio] cached '${text}' ${Math.round(buf.length / 1024)}KB`);
    return p;
  } catch (e) {
    log(`[Audio] download failed '${text}': ${e.message}`);
    return null;
  }
}

/// 缓存 → 下载；返回本地路径或 null（null 时渲染层降级到系统 TTS）
async function generateAudioFile(text, language) {
  return cachedAudioPath(text, language) || await downloadPronunciation(text, language);
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
