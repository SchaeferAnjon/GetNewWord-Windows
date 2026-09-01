# GetNewWord for Windows

macOS 版 GetNewWord 的 Windows 移植（Electron），前后端逻辑与 macOS 版一致：
截图取词 → AI 释义（智谱 GLM-5.3-Flash / DeepSeek）→ 词库 → Anki 卡片自动同步。

## 在 Windows 上运行

1. 安装 [Node.js LTS](https://nodejs.org/)（≥ 20）
2. 拿到本目录（git clone 或直接拷贝 `windows/` 文件夹）
3. 终端里：

```bat
cd windows
npm install
npm start
```

首次启动后：**设置（⚙️）→ API** 填入智谱或 DeepSeek 的 API Key 并验证。

## 打包成安装包（可选）

```bat
npm run dist
```

产物在 `dist/`：`GetNewWord Setup x.x.x.exe`（一键安装）和 portable 版单文件 exe。

## 功能对照（与 macOS 版一致）

- **Ctrl+Shift+A** 框选取词（可在设置里改）；**+Alt** = 快速查词（不入库）
- 框选一松手结果面板立刻弹出（骨架态），三路并行：极速识词+发音 / 主分析 / 提前补全
- 自动保存 + 撤销 + 单项移除；单词/知识片段二选一判定
- 词库：分类树 = Anki 牌组，同词多语境合并，关键词高亮，词性分组释义
- 详情页：朗读（有道真人发音，缓存本地）/ ✨ 重新 AI 生成 / 就地编辑 / 删除（默认连 Anki 卡）
- 列表：拖拽框选、Ctrl/Shift 点选、Ctrl+A 全选、批量归组/同步/删除
- Anki（需装 AnkiConnect 插件，代码 2055492159）：自动同步、卡片带发音/截图/app 风格模板、
  删除双向同步（app 删 → Anki 删；Anki 删 → app 下次同步时也删）
- 设置：浅/深色跟随系统、字号缩放（Ctrl+= / − / 0）、思考模式开关、悬浮球、快捷键录制
- 导入/导出 CSV/JSON（与 macOS 版格式互通，可用来迁移词库）

## 数据位置

`%APPDATA%/getnewword/`：`db.json`（词库）、`settings.json`（含 API Key，明文存本机）、
`audio/`（发音缓存）、`screenshots/`（截图）、`app.log`（日志）。

## 从 macOS 版迁移词库

macOS 版主窗口 → 导出单词 JSON → Windows 版 ⋯ 菜单 → 导入。
