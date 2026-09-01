// applog.js — 极简文件日志：userData/app.log（与 macOS 版 AppLog 一致）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function logFile() {
  return path.join(app.getPath('userData'), 'app.log');
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try { fs.appendFileSync(logFile(), line + '\n'); } catch {}
}

module.exports = { log, logFile };
