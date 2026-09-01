// main-window.js — 主窗口逻辑：侧栏分类树 / 框选多选列表 / 详情与就地编辑 / 批量操作 / 统计 / 设置

let DATA = { words: [], snippets: [], categories: [], settings: {} };

// UI 状态
let tab = 'words';                    // words | snippets | stats
let selectedCategoryId = null;
let groupMode = 'all';
let selectedIds = new Set();          // 单词多选
let anchorId = null;
let selectedSnippetId = null;
let searchText = '';
let editing = false;
let editDraft = null;

const $ = (s) => document.querySelector(s);
const cat = (id) => DATA.categories.find(c => c.id === id) || null;

// ---------- 数据加载 ----------

async function reload(keepSelection = true) {
  DATA = await gnw.invoke('db:all');
  document.documentElement.style.setProperty('--fs', DATA.settings.fontScale || 1);
  if (keepSelection) {
    for (const id of [...selectedIds]) if (!DATA.words.find(w => w.id === id)) selectedIds.delete(id);
    if (selectedSnippetId && !DATA.snippets.find(s => s.id === selectedSnippetId)) selectedSnippetId = null;
  }
  renderAll();
}

gnw.on('db-changed', () => reload());

function renderAll() { renderNav(); renderCatTree(); renderList(); renderDetail(); }

// ---------- 侧栏 ----------

const TABS = [
  { id: 'words', label: '单词', icon: 'Abc', kbd: 'Ctrl+1' },
  { id: 'snippets', label: '知识片段', icon: '📄', kbd: 'Ctrl+2' },
  { id: 'stats', label: '统计', icon: '📊', kbd: 'Ctrl+3' }
];

function renderNav() {
  $('#nav').innerHTML = TABS.map(t =>
    `<div class="nav-row ${tab === t.id ? 'sel' : ''}" data-tab="${t.id}">
      <span style="width:18px;text-align:center;font-size:11px">${t.icon}</span> ${t.label}
      <span class="kbd">${t.kbd}</span>
    </div>`).join('');
  $('#nav').querySelectorAll('.nav-row').forEach(r => r.addEventListener('click', () => {
    tab = r.dataset.tab;
    selectedIds.clear(); selectedSnippetId = null; editing = false;
    $('#colTitle').textContent = TABS.find(t => t.id === tab).label;
    $('#search').placeholder = tab === 'snippets' ? '搜索知识片段...' : '搜索单词、释义、语境...';
    renderAll();
  }));
}

function catCount(c) {
  if (tab === 'snippets') return DATA.snippets.filter(s => s.categoryId === c.id).length;
  if (tab === 'words') return DATA.words.filter(w => w.categoryId === c.id).length;
  return DATA.words.filter(w => w.categoryId === c.id).length + DATA.snippets.filter(s => s.categoryId === c.id).length;
}

function renderCatTree() {
  const roots = DATA.categories.filter(c => !c.parentId);
  const totalCount = tab === 'words' ? DATA.words.length : tab === 'snippets' ? DATA.snippets.length : DATA.words.length + DATA.snippets.length;
  let h = `<div class="section-label" style="padding:12px 8px 6px">分类体系</div>`;
  h += `<div class="cat-row ${selectedCategoryId === null ? 'sel' : ''}" data-cat="">
    <span>🗂</span> 全部 <span class="count">${totalCount}</span></div>`;
  for (const root of roots) {
    h += `<div class="cat-row ${selectedCategoryId === root.id ? 'sel' : ''}" data-cat="${root.id}" data-root="1">
      <span>${root.name === '语言学习' ? '🌐' : '📖'}</span> ${esc(root.name)}</div>`;
    const children = DATA.categories.filter(c => c.parentId === root.id).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const c of children) {
      const n = catCount(c);
      h += `<div class="cat-row child ${selectedCategoryId === c.id ? 'sel' : ''}" data-cat="${c.id}">
        ${esc(c.name)} ${n ? `<span class="count">${n}</span>` : ''}</div>`;
    }
  }
  $('#catTree').innerHTML = h;
  $('#catTree').querySelectorAll('.cat-row').forEach(r => {
    r.addEventListener('click', () => {
      selectedCategoryId = r.dataset.cat || null;
      selectedIds.clear(); selectedSnippetId = null;
      renderAll();
    });
    r.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const id = r.dataset.cat;
      if (!id) return;
      const isRoot = r.dataset.root === '1';
      const items = isRoot
        ? [{ id: 'new', label: '新建分类…' }]
        : [{ id: 'rename', label: '重命名…' }, { id: 'new', label: '新建同级分类…' }, { type: 'separator' }, { id: 'del', label: `删除「${cat(id)?.name}」…` }];
      const clicked = await gnw.invoke('menu:popup', items);
      const c = cat(id);
      if (clicked === 'new') {
        const parent = isRoot ? c : cat(c.parentId);
        promptModal('新建分类', `将创建在「${parent.name}」下，同名 Anki 牌组会在同步时自动创建。`, '名称（如 交通规则）', async (name) => {
          await gnw.invoke('cat:create', name, parent.name === '语言学习');
          reload();
        });
      } else if (clicked === 'rename') {
        promptModal('重命名分类', 'Anki 里对应的牌组会在下次同步时跟着搬过去。', c.name, async (name) => {
          await gnw.invoke('cat:rename', id, name); reload();
        }, c.name);
      } else if (clicked === 'del') {
        confirmModal(`删除分类「${c.name}」？`, `里面的 ${catCount(c)} 个条目不会被删除，会变为「未分组」（单词下次同步按语言归组）。`,
          [{ label: '删除', danger: true, fn: async () => { await gnw.invoke('cat:delete', id); if (selectedCategoryId === id) selectedCategoryId = null; reload(); } }]);
      }
    });
  });
}

$('#groupMode').addEventListener('change', (e) => { groupMode = e.target.value; renderList(); });
$('#search').addEventListener('input', (e) => { searchText = e.target.value.trim().toLowerCase(); renderList(); });

// ---------- 列表 ----------

function filteredWords() {
  let r = [...DATA.words].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (selectedCategoryId) r = r.filter(w => w.categoryId === selectedCategoryId);
  if (searchText) r = r.filter(w =>
    w.word.toLowerCase().includes(searchText) || (w.meaning || '').toLowerCase().includes(searchText) ||
    (w.contextSentence || '').toLowerCase().includes(searchText));
  return r;
}

function filteredSnippets() {
  let r = [...DATA.snippets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (selectedCategoryId) r = r.filter(s => s.categoryId === selectedCategoryId);
  if (searchText) r = r.filter(s =>
    s.title.toLowerCase().includes(searchText) || (s.content || '').toLowerCase().includes(searchText));
  return r;
}

function displayOrder() {
  const words = filteredWords();
  if (groupMode === 'byDay') {
    const groups = new Map();
    for (const w of words) {
      const t = dayGroupTitle(w.createdAt);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(w);
    }
    return [...groups.entries()];
  }
  if (groupMode === 'byDifficulty') {
    return ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']
      .map(d => [d.toUpperCase(), words.filter(w => w.difficulty === d)])
      .filter(([, ws]) => ws.length);
  }
  return [[null, words]];
}

function renderList() {
  const el = $('#list');
  if (tab === 'stats') { el.innerHTML = ''; renderDetail(); return; }
  if (tab === 'snippets') { renderSnippetList(el); return; }

  const groups = displayOrder();
  const total = groups.reduce((n, [, ws]) => n + ws.length, 0);
  if (!total) {
    el.innerHTML = `<div class="empty-list"><div class="big">📖</div><div style="margin-top:10px">暂无单词</div>
      <div style="font-size:calc(11px*var(--fs));color:var(--text3);margin-top:4px">使用截图取词功能添加新单词</div></div>`;
    return;
  }
  let h = '';
  for (const [title, ws] of groups) {
    if (title) h += `<div class="section-label group-header">${esc(title)}</div>`;
    for (const w of ws) h += wordRowHTML(w);
  }
  el.innerHTML = h;
  bindListEvents(el);
}

function wordRowHTML(w) {
  const nCtx = (w.contexts || []).length;
  return `<div class="row ${selectedIds.has(w.id) ? 'sel' : ''}" data-id="${w.id}">
    <div class="l1">
      <span class="w">${esc(w.word)}</span>
      ${w.phonetic ? `<span class="ph">/${esc(w.phonetic)}/</span>` : ''}
      <span class="right">
        ${nCtx > 1 ? `<span class="chip accent" title="遇到 ${nCtx} 次">×${nCtx}</span>` : ''}
        ${w.syncStatus === 'synced' ? '<span class="sync-ok">✓</span>' : w.syncStatus === 'sync_failed' ? '<span class="sync-fail">!</span>' : ''}
        ${diffChip(w.difficulty)}
      </span>
    </div>
    ${w.grammar ? `<div class="gram">${esc(w.grammar)}</div>` : ''}
    <div class="l2">
      <span class="meaning">${esc(w.meaning)}</span>
      <span class="lang">${esc(langName(w.language))}</span>
    </div>
  </div>`;
}

function bindListEvents(el) {
  el.querySelectorAll('.row[data-id]').forEach(r => {
    r.addEventListener('click', (e) => handleWordClick(r.dataset.id, e));
    r.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const id = r.dataset.id;
      const multi = selectedIds.size > 1 && selectedIds.has(id);
      const items = multi
        ? [{ id: 'delMulti', label: `删除选中的 ${selectedIds.size} 个单词…` }]
        : [{ id: 'speak', label: '朗读' }, { type: 'separator' }, { id: 'del', label: `删除「${DATA.words.find(w => w.id === id)?.word}」…` }];
      const clicked = await gnw.invoke('menu:popup', items);
      if (clicked === 'speak') { const w = DATA.words.find(x => x.id === id); speakWord(w.word, w.language); }
      if (clicked === 'del') confirmDeleteWords([id]);
      if (clicked === 'delMulti') confirmDeleteWords([...selectedIds]);
    });
  });
  installMarquee(el);
}

function handleWordClick(id, e) {
  const order = displayOrder().flatMap(([, ws]) => ws).map(w => w.id);
  if (e.ctrlKey || e.metaKey) {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    anchorId = id;
  } else if (e.shiftKey && anchorId) {
    const a = order.indexOf(anchorId), b = order.indexOf(id);
    if (a >= 0 && b >= 0) selectedIds = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    else selectedIds = new Set([id]);
  } else {
    selectedIds = new Set([id]);
    anchorId = id;
  }
  editing = false;
  renderList(); renderDetail();
}

// 框选（marquee）：按下空白处拖动出半透明选框，碰到哪行哪行被选中
function installMarquee(el) {
  let start = null, box = null;
  el.onmousedown = (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, sx: el.scrollLeft, sy: el.scrollTop };
    box = null;
  };
  window.onmousemove = (e) => {
    if (!start) return;
    const dx = Math.abs(e.clientX - start.x), dy = Math.abs(e.clientY - start.y);
    if (!box && dx < 6 && dy < 6) return;
    if (!box) {
      box = document.createElement('div');
      box.className = 'marquee';
      el.appendChild(box);
    }
    const elRect = el.getBoundingClientRect();
    const x1 = Math.min(start.x, e.clientX) - elRect.left, y1 = Math.min(start.y, e.clientY) - elRect.top + el.scrollTop;
    const x2 = Math.max(start.x, e.clientX) - elRect.left, y2 = Math.max(start.y, e.clientY) - elRect.top + el.scrollTop;
    Object.assign(box.style, { left: x1 + 'px', top: y1 + 'px', width: (x2 - x1) + 'px', height: (y2 - y1) + 'px' });
    // 命中检测
    const hit = new Set();
    el.querySelectorAll('.row[data-id]').forEach(r => {
      const rr = r.getBoundingClientRect();
      const ry1 = rr.top - elRect.top + el.scrollTop, ry2 = ry1 + rr.height;
      if (ry2 > y1 && ry1 < y2) hit.add(r.dataset.id);
    });
    selectedIds = hit;
    el.querySelectorAll('.row[data-id]').forEach(r => r.classList.toggle('sel', selectedIds.has(r.dataset.id)));
  };
  window.onmouseup = () => {
    if (box) { box.remove(); renderDetail(); }
    start = null; box = null;
  };
}

function renderSnippetList(el) {
  const snips = filteredSnippets();
  if (!snips.length) {
    el.innerHTML = `<div class="empty-list"><div class="big">📄</div><div style="margin-top:10px">暂无知识片段</div>
      <div style="font-size:calc(11px*var(--fs));color:var(--text3);margin-top:4px">截图时框选一段说明性文字即可保存为知识片段</div></div>`;
    return;
  }
  el.innerHTML = snips.map(s => `<div class="row ${selectedSnippetId === s.id ? 'sel' : ''}" data-sid="${s.id}">
    <div class="l1"><span class="w" style="font-size:calc(13.5px*var(--fs))">${esc(s.title)}</span>
      <span class="right">
        ${s.syncStatus === 'synced' ? '<span class="sync-ok">✓</span>' : ''}
        <span class="chip accent sans">${esc(cat(s.categoryId)?.name || '未分组')}</span>
      </span></div>
    <div class="l2"><span class="meaning">${esc((s.content || '').slice(0, 120))}</span></div>
    <div class="d-ctx-meta">${fmtDate(s.createdAt)}</div>
  </div>`).join('');
  el.onmousedown = null;
  el.querySelectorAll('.row[data-sid]').forEach(r => {
    r.addEventListener('click', () => { selectedSnippetId = r.dataset.sid; renderList(); renderDetail(); });
    r.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const clicked = await gnw.invoke('menu:popup', [{ id: 'del', label: `删除「${DATA.snippets.find(s => s.id === r.dataset.sid)?.title}」…` }]);
      if (clicked === 'del') confirmDeleteSnippet(r.dataset.sid);
    });
  });
}

// ---------- 删除确认 ----------

function confirmDeleteWords(ids) {
  const n = ids.length;
  confirmModal(`删除 ${n} 个单词？`, '不可撤销。「仅本地」保留 Anki 里的卡和复习进度。', [
    { label: '删除（含 Anki 卡）', danger: true, fn: async () => { await gnw.invoke('db:deleteWords', ids, true); ids.forEach(id => selectedIds.delete(id)); reload(); } },
    { label: '仅本地删除', danger: true, fn: async () => { await gnw.invoke('db:deleteWords', ids, false); ids.forEach(id => selectedIds.delete(id)); reload(); } }
  ]);
}

function confirmDeleteSnippet(id) {
  const s = DATA.snippets.find(x => x.id === id);
  confirmModal(`删除「${s.title}」？`, '此操作不可撤销。「仅本地」保留 Anki 里的卡和复习进度。', [
    { label: '删除（含 Anki 卡）', danger: true, fn: async () => { await gnw.invoke('db:deleteSnippets', [id], true); if (selectedSnippetId === id) selectedSnippetId = null; reload(); } },
    { label: '仅本地删除', danger: true, fn: async () => { await gnw.invoke('db:deleteSnippets', [id], false); if (selectedSnippetId === id) selectedSnippetId = null; reload(); } }
  ]);
}

// ---------- 详情 ----------

function renderDetail() {
  const el = $('#detailCol');
  if (tab === 'stats') { el.innerHTML = statsHTML(); return; }
  if (tab === 'snippets') {
    const s = DATA.snippets.find(x => x.id === selectedSnippetId);
    el.innerHTML = s ? snippetDetailHTML(s) : placeholderHTML('📄', '选择知识片段查看详情');
    if (s) bindSnippetDetail(el, s);
    return;
  }
  if (selectedIds.size > 1) {
    el.innerHTML = batchHTML();
    bindBatch(el);
    return;
  }
  const w = selectedIds.size === 1 ? DATA.words.find(x => x.id === [...selectedIds][0]) : null;
  if (!w) { el.innerHTML = placeholderHTML('📖', '选择单词查看详情'); return; }
  el.innerHTML = editing ? editHTML(w) : detailHTML(w);
  (editing ? bindEdit : bindDetail)(el, w);
}

const placeholderHTML = (icon, text) => `<div class="placeholder"><div class="big">${icon}</div><div>${text}</div></div>`;

function detailHTML(w) {
  const contexts = (w.contexts || []);
  const syncClass = w.syncStatus === 'synced' ? 'ok' : w.syncStatus === 'sync_failed' ? 'danger' : '';
  let h = `<div class="detail">
    <div>
      <div style="display:flex;align-items:baseline;gap:12px">
        <span class="d-word">${esc(w.word)}</span>
        ${w.phonetic ? `<span class="d-ph">/${esc(w.phonetic)}/</span>` : ''}
      </div>
      ${w.grammar ? `<div class="d-gram">${esc(w.grammar)}</div>` : ''}
      <div style="display:flex;align-items:center;gap:6px;margin-top:10px">
        ${diffChip(w.difficulty)}
        <span class="chip sans">${esc(langName(w.language))}</span>
        <span class="chip sans ${syncClass}">${SYNC_NAMES[w.syncStatus] || ''}</span>
        <span class="d-actions">
          <button class="icon-btn" id="dSpeak" title="朗读（空格）">🔊</button>
          <button class="icon-btn" id="dRegen" title="重新 AI 生成：释义（含词性）/ 用法 / 例句 / 词根词源">✨</button>
          <button class="icon-btn" id="dEdit" title="编辑（Ctrl+E）">✏️</button>
          <button class="icon-btn danger" id="dDel" title="删除">🗑</button>
        </span>
      </div>
    </div>
    <hr class="hairline">
    <div class="sec"><div class="section-label">释义</div>
      <div class="d-meaning">${emphasizeMeaningHTML(w.contextMeaning, w.meaning)}</div></div>`;

  if (contexts.length) {
    h += `<div class="sec"><div class="section-label">语境 ${contexts.length > 1 ? `<span class="trailing">遇到 ${contexts.length} 次</span>` : ''}</div>`;
    contexts.forEach((c, i) => {
      h += `<div class="quote-block">
        <div class="d-ctx">${hlHTML(w.word, c.sentence)}</div>
        ${c.translation ? `<div class="d-ctx-tr">${esc(c.translation)}</div>` : ''}
        <div class="d-ctx-meta">${contexts.length > 1 ? `#${i + 1} · ` : ''}${fmtDate(c.createdAt, true)}</div>
      </div>`;
      if (contexts.length > 1 && c.screenshotPath) h += `<div class="d-shot" data-shot="${esc(c.screenshotPath)}"></div>`;
    });
    h += `</div>`;
  }

  if (w.analysisNote) h += `<div class="sec"><div class="section-label">用法</div><div class="usage-box">${esc(w.analysisNote)}</div></div>`;
  if (w.collocationsText) h += `<div class="sec"><div class="section-label">搭配</div>${w.collocationsText.split('\n').map(l => `<div class="d-extra">${hlHTML(w.word, l)}</div>`).join('')}</div>`;
  if (w.examplesText) h += `<div class="sec"><div class="section-label">例句</div>${w.examplesText.split('\n').map(l => `<div class="d-extra">${hlHTML(w.word, l)}</div>`).join('')}</div>`;
  if (w.etymology) h += `<div class="sec"><div class="section-label">词根词源</div><div class="d-ety">${esc(w.etymology)}</div></div>`;
  if (contexts.length <= 1 && w.screenshotPath) h += `<div class="sec"><div class="section-label">截图</div><div class="d-shot" data-shot="${esc(w.screenshotPath)}"></div></div>`;

  h += `<hr class="hairline">
    <div class="sec"><div class="section-label">元信息</div>
      <div class="meta-row"><span class="k">创建</span>${fmtDate(w.createdAt, true)}</div>
      <div class="meta-row"><span class="k">复习</span>${w.reviewCount || 0} 次</div>
      ${w.ankiNoteId ? `<div class="meta-row"><span class="k">Anki</span>${w.ankiNoteId}</div>` : ''}
    </div>
  </div>`;
  return h;
}

async function bindDetail(el, w) {
  $('#dSpeak')?.addEventListener('click', () => speakWord(w.word, w.language));
  $('#dEdit')?.addEventListener('click', () => { beginEdit(w); });
  $('#dDel')?.addEventListener('click', () => confirmDeleteWords([w.id]));
  $('#dRegen')?.addEventListener('click', async function () {
    this.innerHTML = '<span class="spinner"></span>';
    try { await gnw.invoke('ai:regenerate', w.id); } catch {}
    reload();
  });
  // 截图（本地文件经 gnwfile 协议）
  for (const shot of el.querySelectorAll('.d-shot[data-shot]')) {
    const url = await gnw.invoke('file:url', shot.dataset.shot);
    if (url) shot.innerHTML = `<img src="${url}">`;
    else shot.innerHTML = `<span class="set-note">截图文件不可用</span>`;
  }
}

// ---------- 编辑 ----------

function beginEdit(w) {
  editing = true;
  editDraft = {
    word: w.word, phonetic: w.phonetic || '', grammar: w.grammar || '',
    meaning: w.meaning, analysisNote: w.analysisNote || '',
    contexts: (w.contexts || []).map(c => ({ ...c }))
  };
  renderDetail();
}

function editHTML(w) {
  const d = editDraft;
  return `<div class="detail">
    <div class="sec">
      <div style="display:flex;gap:8px">
        <input class="gnw edit-field" id="eWord" value="${esc(d.word)}" style="font-weight:700;font-size:calc(17px*var(--fs))">
        <input class="gnw" id="ePhonetic" value="${esc(d.phonetic)}" placeholder="音标" style="width:170px">
      </div>
      <input class="gnw edit-field mono" id="eGrammar" value="${esc(d.grammar)}" placeholder="语法：der Fahrer, die Fahrer / trennbar · hält an · hielt an · hat angehalten">
    </div>
    <div class="sec"><div class="section-label">释义</div><textarea class="gnw" id="eMeaning">${esc(d.meaning)}</textarea></div>
    <div class="sec"><div class="section-label">语境</div>
      ${d.contexts.map((c, i) => `<div class="sec" data-ci="${i}">
        <textarea class="gnw eCtxS" data-i="${i}">${esc(c.sentence)}</textarea>
        <textarea class="gnw eCtxT" data-i="${i}" style="min-height:36px">${esc(c.translation)}</textarea>
        ${d.contexts.length > 1 ? `<button class="btn small danger eCtxDel" data-i="${i}" style="align-self:flex-start">删除这条语境</button>` : ''}
      </div>`).join('')}
    </div>
    <div class="sec"><div class="section-label">用法</div><textarea class="gnw" id="eNote">${esc(d.analysisNote)}</textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" id="eCancel">取消</button>
      <button class="btn primary" id="eSave">保存</button>
    </div>
  </div>`;
}

function bindEdit(el, w) {
  el.querySelectorAll('.eCtxDel').forEach(b => b.addEventListener('click', async () => {
    const c = editDraft.contexts[+b.dataset.i];
    await gnw.invoke('db:deleteContext', w.id, c.id);
    editDraft.contexts.splice(+b.dataset.i, 1);
    renderDetail();
  }));
  $('#eCancel').addEventListener('click', () => { editing = false; renderDetail(); });
  $('#eSave').addEventListener('click', async () => {
    el.querySelectorAll('.eCtxS').forEach(t => editDraft.contexts[+t.dataset.i].sentence = t.value);
    el.querySelectorAll('.eCtxT').forEach(t => editDraft.contexts[+t.dataset.i].translation = t.value);
    const patch = {
      word: $('#eWord').value.trim(), phonetic: $('#ePhonetic').value.trim(),
      grammar: $('#eGrammar').value.trim(), meaning: $('#eMeaning').value,
      analysisNote: $('#eNote').value, contexts: editDraft.contexts
    };
    if (patch.contexts.length) {
      patch.contextSentence = patch.contexts[0].sentence;
      patch.contextTranslation = patch.contexts[0].translation;
    }
    await gnw.invoke('db:updateWord', w.id, patch);
    editing = false;
    reload();
  });
}

// ---------- 批量 ----------

function batchHTML() {
  const words = DATA.words.filter(w => selectedIds.has(w.id));
  const langCats = DATA.categories.filter(c => cat(c.parentId)?.name === '语言学习');
  return `<div class="detail">
    <div>
      <div style="font-size:calc(21px*var(--fs));font-weight:700">已选中 ${words.length} 个单词</div>
      <div style="font-size:calc(12.5px*var(--fs));color:var(--text2);margin-top:6px">${esc(words.slice(0, 8).map(w => w.word).join('、'))}${words.length > 8 ? ' …' : ''}</div>
    </div>
    <hr class="hairline">
    <div class="sec"><div class="section-label">批量操作</div>
      <div class="set-row">📁 归入
        <select class="gnw" id="bCat">
          <option value="">选择分类…</option>
          ${langCats.map(c => `<option value="${c.id}">语言学习 › ${esc(c.name)}</option>`).join('')}
          <option value="__none__">未分组</option>
        </select>
      </div>
      <div class="set-row">🔄 <button class="btn" id="bSync">同步这 ${words.length} 个到 Anki</button></div>
      <div class="set-row">🔊 <button class="btn" id="bSpeak">依次朗读</button></div>
      <div class="set-row">🗑 <button class="btn danger" id="bDel">删除这 ${words.length} 个单词…</button></div>
    </div>
    <div class="set-note" style="margin-top:auto">提示：列表里按住拖动可连选，Ctrl 点选、Shift 范围选，Ctrl+A 全选</div>
  </div>`;
}

function bindBatch(el) {
  const ids = [...selectedIds];
  $('#bCat').addEventListener('change', async (e) => {
    if (!e.target.value) return;
    await gnw.invoke('db:assignCategory', 'words', ids, e.target.value === '__none__' ? null : e.target.value);
    reload();
  });
  $('#bSync').addEventListener('click', async function () {
    this.textContent = '同步中…'; this.disabled = true;
    for (const id of ids) await gnw.invoke('db:updateWord', id, {});
    await gnw.invoke('anki:sync');
    reload();
  });
  $('#bSpeak').addEventListener('click', async () => {
    for (const id of ids) {
      const w = DATA.words.find(x => x.id === id);
      if (w) { await speakWord(w.word, w.language); await new Promise(r => setTimeout(r, 1600)); }
    }
  });
  $('#bDel').addEventListener('click', () => confirmDeleteWords(ids));
}

// ---------- 片段详情 ----------

function snippetDetailHTML(s) {
  const c = cat(s.categoryId);
  return `<div class="detail">
    <div>
      <div style="font-size:calc(24px*var(--fs));font-weight:700;user-select:text">${esc(s.title)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
        <span class="chip accent sans">${esc(cat(c?.parentId)?.name || '知识片段')} › ${esc(c?.name || '未分组')}</span>
        <span class="set-note">${fmtDate(s.createdAt)}</span>
        <span class="chip sans ${s.syncStatus === 'synced' ? 'ok' : ''}">${SYNC_NAMES[s.syncStatus] || ''}</span>
        <span class="d-actions"><button class="icon-btn danger" id="sDel" title="删除">🗑</button></span>
      </div>
    </div>
    <hr class="hairline">
    <div class="sec"><div class="section-label">内容</div>
      <div class="d-extra" style="white-space:pre-wrap">${esc(s.content)}</div></div>
    ${s.sourceContext ? `<div class="sec"><div class="section-label">原始上下文</div>
      <div class="usage-box" style="font-style:italic">${esc(s.sourceContext)}</div></div>` : ''}
    ${s.screenshotPath ? `<div class="sec"><div class="section-label">截图</div><div class="d-shot" data-shot="${esc(s.screenshotPath)}"></div></div>` : ''}
    <hr class="hairline">
    <div class="sec"><div class="section-label">元信息</div>
      <div class="meta-row"><span class="k">创建</span>${fmtDate(s.createdAt, true)}</div>
      ${s.ankiNoteId ? `<div class="meta-row"><span class="k">Anki</span>${s.ankiNoteId}</div>` : ''}
    </div>
  </div>`;
}

async function bindSnippetDetail(el, s) {
  $('#sDel')?.addEventListener('click', () => confirmDeleteSnippet(s.id));
  for (const shot of el.querySelectorAll('.d-shot[data-shot]')) {
    const url = await gnw.invoke('file:url', shot.dataset.shot);
    if (url) shot.innerHTML = `<img src="${url}">`;
  }
}

// ---------- 统计 ----------

function statsHTML() {
  const words = DATA.words, snippets = DATA.snippets;
  const today = words.filter(w => dayGroupTitle(w.createdAt) === '今天').length;
  // 连续学习天数
  const days = new Set(words.map(w => new Date(w.createdAt).toDateString()));
  let streak = 0; const d = new Date();
  while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }

  const diffColors = { a1: '#28965A', a2: '#3EB489', b1: '#5460D2', b2: '#CD7D14', c1: '#C83C3C', c2: '#8E44AD' };
  const diffBars = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].map(diff => {
    const n = words.filter(w => w.difficulty === diff).length;
    const pct = words.length ? n / words.length * 100 : 0;
    return `<div class="bar-row"><span class="lab">${diff.toUpperCase()}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${diffColors[diff]}"></div></div>
      <span class="n">${n}</span></div>`;
  }).join('');

  const domainCounts = new Map();
  for (const s of snippets) {
    const name = cat(s.categoryId)?.name || s.domain || '未分组';
    domainCounts.set(name, (domainCounts.get(name) || 0) + 1);
  }
  const domainBars = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => {
    const pct = snippets.length ? n / snippets.length * 100 : 0;
    return `<div class="bar-row"><span class="lab">${esc(name)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:rgba(242,158,64,.65)"></div></div>
      <span class="n">${n}</span></div>`;
  }).join('') || '<div class="set-note">暂无数据</div>';

  const card = (title, v, icon, color) => `<div class="stat-card" style="background:${color}14">
    <div style="font-size:18px">${icon}</div><div class="v">${v}</div><div class="t">${title}</div></div>`;

  return `<div class="stats">
    <div style="font-size:calc(24px*var(--fs));font-weight:700">学习统计</div>
    <div class="stat-cards">
      ${card('总单词数', words.length, '🔤', '#5460D2')}
      ${card('知识片段数', snippets.length, '📄', '#CD7D14')}
      ${card('今日新增', today, '📅', '#28965A')}
      ${card('连续学习', streak + ' 天', '🔥', '#C83C3C')}
    </div>
    <hr class="hairline">
    <div class="sec"><div class="section-label">难度分布</div>${words.length ? diffBars : '<div class="set-note">暂无数据</div>'}</div>
    <hr class="hairline">
    <div class="sec"><div class="section-label">领域分布</div>${domainBars}</div>
  </div>`;
}

// ---------- 弹窗 ----------

function confirmModal(title, message, actions) {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-mask"><div class="modal">
    <h3>${esc(title)}</h3>
    <div class="m-body">${esc(message)}</div>
    <div class="m-actions">
      <button class="btn" data-a="-1">取消</button>
      ${actions.map((a, i) => `<button class="btn ${a.danger ? 'danger' : 'primary'}" data-a="${i}">${esc(a.label)}</button>`).join('')}
    </div></div></div>`;
  host.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.a;
    host.innerHTML = '';
    if (i >= 0) actions[i].fn();
  }));
}

function promptModal(title, message, placeholder, fn, initial = '') {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-mask"><div class="modal">
    <h3>${esc(title)}</h3>
    <div class="m-body">${esc(message)}<input class="gnw" id="pmInput" placeholder="${esc(placeholder)}" value="${esc(initial)}"></div>
    <div class="m-actions"><button class="btn" id="pmCancel">取消</button><button class="btn primary" id="pmOk">确定</button></div>
  </div></div>`;
  $('#pmInput').focus();
  $('#pmInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pmOk').click(); });
  $('#pmCancel').addEventListener('click', () => host.innerHTML = '');
  $('#pmOk').addEventListener('click', () => {
    const v = $('#pmInput').value.trim();
    host.innerHTML = '';
    if (v) fn(v);
  });
}

// ---------- 设置 ----------

let settingsTab = 'general';
let hotkeyRecording = false;

function openSettings() {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-mask" id="setMask"><div class="modal" style="width:520px">
    <h3>设置</h3>
    <div class="settings-tabs" id="setTabs">
      <button data-t="general">通用</button><button data-t="api">API</button>
      <button data-t="hotkey">截图</button><button data-t="anki">Anki</button>
    </div>
    <div class="m-body" id="setBody" style="min-height:300px"></div>
    <div class="m-actions"><button class="btn primary" id="setClose">完成</button></div>
  </div></div>`;
  $('#setClose').addEventListener('click', () => host.innerHTML = '');
  $('#setMask').addEventListener('mousedown', (e) => { if (e.target.id === 'setMask') host.innerHTML = ''; });
  $('#setTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { settingsTab = b.dataset.t; renderSettings(); }));
  renderSettings();
}

async function renderSettings() {
  $('#setTabs').querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.t === settingsTab));
  const s = DATA.settings;
  const body = $('#setBody');

  if (settingsTab === 'general') {
    body.innerHTML = `
      <div class="set-row">外观 <span class="seg" id="segApp">
        <button data-v="system">跟随系统</button><button data-v="light">浅色</button><button data-v="dark">深色</button></span></div>
      <div class="set-row">字号 <input type="range" class="grow" id="fsSlider" min="0.85" max="1.5" step="0.05" value="${s.fontScale || 1}">
        <span class="mono" id="fsVal">${Math.round((s.fontScale || 1) * 100)}%</span>
        <button class="btn small" id="fsReset">重置</button></div>
      <div class="set-note">也可用 Ctrl+= / Ctrl+− / Ctrl+0 调整</div>
      <div class="set-row"><label><input type="checkbox" id="ckSpeak" ${s.autoSpeak ? 'checked' : ''}> 查词后自动朗读</label></div>
      <div class="set-row"><label><input type="checkbox" id="ckFloat" ${s.showFloatingButton ? 'checked' : ''}> 桌面悬浮按钮</label></div>`;
    body.querySelector('#segApp').querySelectorAll('button').forEach(b => {
      b.classList.toggle('sel', b.dataset.v === (s.appearance || 'system'));
      b.addEventListener('click', async () => { await gnw.invoke('settings:set', 'appearance', b.dataset.v); await reload(); renderSettings(); });
    });
    $('#fsSlider').addEventListener('change', async (e) => { await gnw.invoke('settings:set', 'fontScale', +e.target.value); await reload(); renderSettings(); });
    $('#fsSlider').addEventListener('input', (e) => $('#fsVal').textContent = Math.round(e.target.value * 100) + '%');
    $('#fsReset').addEventListener('click', async () => { await gnw.invoke('settings:set', 'fontScale', 1); await reload(); renderSettings(); });
    $('#ckSpeak').addEventListener('change', (e) => gnw.invoke('settings:set', 'autoSpeak', e.target.checked));
    $('#ckFloat').addEventListener('change', (e) => gnw.invoke('settings:set', 'showFloatingButton', e.target.checked));
  }

  if (settingsTab === 'api') {
    body.innerHTML = `
      <div class="set-row">截图分析用 <span class="seg" id="segProv">
        <button data-v="zhipu">智谱 GLM-5.3-Flash</button><button data-v="deepseek">DeepSeek V4</button></span></div>
      <div class="set-note">切换后立即生效；两边的 Key 都会保存，随时可切回</div>
      <hr class="hairline">
      <div class="set-row"><label><input type="checkbox" id="ckThink" ${s.thinkingEnabled ? 'checked' : ''}> 开启思考（更准但更慢）</label>
        <span class="seg" id="segThink">
          <button data-v="low">低</button><button data-v="high">高</button><button data-v="max">最高</button></span></div>
      <div class="set-note">默认关闭。仅对智谱生效；DeepSeek 忽略此设置。开着会显著变慢，日常取词不建议开。</div>
      <hr class="hairline">
      <div class="section-label">智谱 BigModel API</div>
      <div class="set-row"><input class="gnw grow" type="password" id="keyZhipu" value="${esc(s.zhipuKey || '')}" placeholder="API Key">
        <button class="btn small" id="valZhipu">验证</button><span id="valZhipuR"></span></div>
      <div class="section-label">DeepSeek API</div>
      <div class="set-row"><input class="gnw grow" type="password" id="keyDS" value="${esc(s.deepseekKey || '')}" placeholder="DeepSeek API Key">
        <button class="btn small" id="valDS">验证</button><span id="valDSR"></span></div>
      <div class="set-note">Key 保存在本机 settings.json，不会上传。</div>`;
    body.querySelector('#segProv').querySelectorAll('button').forEach(b => {
      b.classList.toggle('sel', b.dataset.v === (s.apiProvider || 'zhipu'));
      b.addEventListener('click', async () => { await gnw.invoke('settings:set', 'apiProvider', b.dataset.v); await reload(); renderSettings(); });
    });
    body.querySelector('#segThink').querySelectorAll('button').forEach(b => {
      b.classList.toggle('sel', b.dataset.v === (s.thinkingLevel || 'low'));
      b.addEventListener('click', async () => { await gnw.invoke('settings:set', 'thinkingLevel', b.dataset.v); await reload(); renderSettings(); });
    });
    $('#ckThink').addEventListener('change', (e) => gnw.invoke('settings:set', 'thinkingEnabled', e.target.checked));
    const wireKey = (inputId, btnId, resId, provider, key) => {
      $('#' + inputId).addEventListener('change', (e) => gnw.invoke('settings:set', key, e.target.value.trim()));
      $('#' + btnId).addEventListener('click', async () => {
        const v = $('#' + inputId).value.trim();
        if (!v) return;
        $('#' + resId).innerHTML = '<span class="spinner"></span>';
        await gnw.invoke('settings:set', key, v);
        const r = await gnw.invoke('ai:validateKey', v, provider);
        $('#' + resId).innerHTML = r.valid ? '<span style="color:var(--ok)">✓ 有效</span>' : `<span style="color:var(--danger)">✗ ${esc(r.error || '无效')}</span>`;
      });
    };
    wireKey('keyZhipu', 'valZhipu', 'valZhipuR', 'zhipu', 'zhipuKey');
    wireKey('keyDS', 'valDS', 'valDSR', 'deepseek', 'deepseekKey');
  }

  if (settingsTab === 'hotkey') {
    body.innerHTML = `
      <div class="set-row">截图取词 <span class="grow"></span>
        <span class="hotkey-box" id="hkBox">${esc(s.hotkey || 'Ctrl+Shift+A')}</span>
        <button class="btn small" id="hkReset">重置</button></div>
      <div class="set-note">点击录入框后按下组合键（需含 Ctrl/Alt/Shift/Win），Esc 取消；改完立即生效。同组合键 + Alt = 快速查词（不入库）。</div>`;
    const box = $('#hkBox');
    box.addEventListener('click', () => {
      hotkeyRecording = true;
      box.classList.add('rec');
      box.textContent = '按下组合键…';
    });
    $('#hkReset').addEventListener('click', async () => {
      await gnw.invoke('settings:set', 'hotkey', 'CommandOrControl+Shift+A');
      await reload(); renderSettings();
    });
  }

  if (settingsTab === 'anki') {
    body.innerHTML = `<div class="set-row"><span id="ankiDot">●</span> <span id="ankiState">检测中…</span>
      <span class="grow"></span><button class="btn small" id="ankiTest">测试连接</button></div>
      <div class="anki-stat" id="ankiStat"></div>
      <div class="sec"><div class="section-label">牌组</div><div id="ankiDecks" class="set-note">—</div></div>
      <div class="set-row"><button class="btn primary" id="ankiSyncNow">立即同步</button></div>
      <div class="set-note">需要 Anki 桌面版运行且已装 AnkiConnect 插件（代码 2055492159）。牌组 = 左侧分类树，卡片包含发音、截图和关键词高亮。</div>`;
    const refreshAnki = async () => {
      const st = await gnw.invoke('anki:status');
      $('#ankiDot').style.color = st.running ? 'var(--ok)' : 'var(--danger)';
      $('#ankiState').textContent = st.running ? '已连接' : '未连接（请启动 Anki）';
      const synced = DATA.words.filter(w => w.syncStatus === 'synced').length;
      const pending = DATA.words.filter(w => w.syncStatus === 'not_synced').length;
      const failed = DATA.words.filter(w => w.syncStatus === 'sync_failed').length;
      $('#ankiStat').innerHTML = [['已同步', synced, 'var(--ok)'], ['待同步', pending, 'var(--warn)'], ['失败', failed, 'var(--danger)']]
        .map(([t, v, c]) => `<div class="item"><div class="v" style="color:${c}">${v}</div><div class="t">${t}</div></div>`).join('');
      if (st.running) {
        const decks = await gnw.invoke('anki:decks');
        $('#ankiDecks').textContent = decks.length ? decks.join('、') : '暂无牌组';
      }
    };
    $('#ankiTest').addEventListener('click', refreshAnki);
    $('#ankiSyncNow').addEventListener('click', async function () {
      this.textContent = '同步中…'; this.disabled = true;
      await gnw.invoke('anki:sync');
      this.textContent = '立即同步'; this.disabled = false;
      await reload(); refreshAnki();
    });
    refreshAnki();
  }
}

// 快捷键录制
window.addEventListener('keydown', async (e) => {
  if (hotkeyRecording) {
    e.preventDefault();
    if (e.key === 'Escape') { hotkeyRecording = false; renderSettings(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (!mods.length) return;
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const acc = [...mods, key].join('+');
    hotkeyRecording = false;
    await gnw.invoke('settings:set', 'hotkey', acc);
    await reload();
    if ($('#hkBox')) renderSettings();
    return;
  }
  // 全局快捷键（窗口内）
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && tab === 'words' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    selectedIds = new Set(displayOrder().flatMap(([, ws]) => ws).map(w => w.id));
    renderList(); renderDetail();
  }
  if ((e.ctrlKey || e.metaKey) && ['1', '2', '3'].includes(e.key)) {
    tab = ['words', 'snippets', 'stats'][+e.key - 1];
    $('#colTitle').textContent = TABS.find(t => t.id === tab).label;
    renderAll();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) stepFont(+1);
  if ((e.ctrlKey || e.metaKey) && e.key === '-') stepFont(-1);
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { gnw.invoke('settings:set', 'fontScale', 1).then(reload); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'e' && selectedIds.size === 1 && !editing) {
    const w = DATA.words.find(x => x.id === [...selectedIds][0]);
    if (w) beginEdit(w);
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') gnw.invoke('anki:sync').then(reload);
  if (e.key === ' ' && selectedIds.size === 1 && !editing && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    const w = DATA.words.find(x => x.id === [...selectedIds][0]);
    if (w) { e.preventDefault(); speakWord(w.word, w.language); }
  }
});

const FONT_STEPS = [0.85, 0.92, 1.0, 1.1, 1.2, 1.35, 1.5];
async function stepFont(delta) {
  const cur = DATA.settings.fontScale || 1;
  let idx = FONT_STEPS.findIndex(v => Math.abs(v - cur) < 0.01);
  if (idx < 0) idx = 2;
  const next = FONT_STEPS[Math.min(Math.max(idx + delta, 0), FONT_STEPS.length - 1)];
  await gnw.invoke('settings:set', 'fontScale', next);
  reload();
}

// ---------- 工具栏 ----------

$('#btnCapture').addEventListener('click', () => gnw.invoke('analysis:trigger', 'capture'));
$('#btnSync').addEventListener('click', async function () { this.textContent = '⏳'; await gnw.invoke('anki:sync'); this.textContent = '🔄'; reload(); });
$('#btnSettings').addEventListener('click', openSettings);
$('#btnMore').addEventListener('click', async () => {
  const clicked = await gnw.invoke('menu:popup', [
    { id: 'exportCsv', label: '导出单词 CSV' },
    { id: 'exportJson', label: '导出单词 JSON' },
    { type: 'separator' },
    { id: 'import', label: '导入（CSV / JSON）…' }
  ]);
  if (clicked === 'exportCsv') gnw.invoke('export:words', 'csv');
  if (clicked === 'exportJson') gnw.invoke('export:words', 'json');
  if (clicked === 'import') {
    const r = await gnw.invoke('import:words');
    if (r.count) { confirmModal('导入结果', `成功导入 ${r.count} 条记录`, []); reload(); }
    else if (r.error) confirmModal('导入失败', r.error, []);
  }
});

// 启动
reload();
