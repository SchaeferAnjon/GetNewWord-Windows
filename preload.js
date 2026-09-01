// preload.js — contextBridge：渲染层唯一的主进程入口
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gnw', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, fn) => {
    const wrapped = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
