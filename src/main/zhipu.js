// zhipu.js — AI 服务层：智谱 GLM-5.3-Flash / DeepSeek V4 Flash Vision
// 提示词与解析逻辑逐行移植自 macOS 版 ZhipuService.swift

const db = require('./db');
const { log } = require('./applog');

const PROVIDERS = {
  zhipu: {
    displayName: '智谱 GLM-5.3-Flash',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    model: 'glm-5.3-flash',
    keySetting: 'zhipuKey',
    supportsThinking: true
  },
  deepseek: {
    displayName: 'DeepSeek V4 Flash Vision',
    baseURL: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash-vision-exp',
    keySetting: 'deepseekKey',
    supportsThinking: false
  }
};

const currentProvider = () => PROVIDERS[db.getSetting('apiProvider')] || PROVIDERS.zhipu;
const apiKey = (p) => db.getSetting((p || currentProvider()).keySetting) || '';
const isConfigured = () => !!apiKey();
const currentProviderName = () => currentProvider().displayName;

/// 思考配置：默认关；等级 low/high/max 仅智谱生效
function thinkingConfig(p) {
  if (!p.supportsThinking) return undefined;
  if (!db.getSetting('thinkingEnabled')) return { type: 'disabled' };
  return { type: db.getSetting('thinkingLevel') || 'low' };
}

const RETRY_DELAYS = [1000, 2000];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// 发送 API 请求（重试机制与 macOS 版一致：5xx / 网络错误重试 2 次）
async function sendRequest(messages, { maxTokens = 8192, retry = 0 } = {}) {
  const p = currentProvider();
  const key = apiKey(p);
  if (!key) throw new Error(`未配置 ${p.displayName} 的 API Key，请打开设置 → API 填写`);

  const body = {
    model: p.model, messages, temperature: 0.3, max_tokens: maxTokens,
    response_format: { type: 'json_object' }
  };
  const thinking = thinkingConfig(p);
  if (thinking) body.thinking = thinking;

  const payload = JSON.stringify(body);
  const started = Date.now();
  log(`[Zhipu] → POST ${p.baseURL} model=${p.model} body=${Math.round(payload.length / 1024)}KB thinking=${thinking?.type || 'n/a'} retry=${retry}`);

  let res, data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300000);   // 5 分钟超时
    res = await fetch(p.baseURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: payload, signal: ctrl.signal
    });
    data = await res.text();
    clearTimeout(timer);
  } catch (e) {
    log(`[Zhipu] ✗ network ${e.message} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (retry < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[retry]);
      return sendRequest(messages, { maxTokens, retry: retry + 1 });
    }
    throw new Error(`网络请求失败：${e.message}`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log(`[Zhipu] ← HTTP ${res.status} after ${elapsed}s, ${Math.round(data.length / 1024)}KB`);

  if (!res.ok) {
    if (res.status >= 500 && retry < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[retry]);
      return sendRequest(messages, { maxTokens, retry: retry + 1 });
    }
    let msg = `HTTP 状态码 ${res.status}`;
    try { msg = JSON.parse(data).error?.message || msg; } catch {}
    log(`[Zhipu] ✗ API error: ${data.slice(0, 500)}`);
    throw new Error(`API 错误：${msg}`);
  }

  const parsed = JSON.parse(data);
  const choice = parsed.choices?.[0];
  log(`[Zhipu] ✓ finish=${choice?.finish_reason} content=${choice?.message?.content?.length || 0}ch usage=${parsed.usage?.completion_tokens ?? -1}`);
  return parsed;
}

// ---------- JSON 提取 / 解析（四段策略，与 macOS 版一致） ----------

function extractJSON(text) {
  for (const re of [/```json\s*\n([\s\S]*?)\n\s*```/, /```\s*\n([\s\S]*?)\n\s*```/]) {
    const m = text.match(re);
    if (m) return m[1];
  }
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text;
}

const cleanJSON = (s) => s.trim().replace(/,\s*([}\]])/g, '$1');

const validResult = (r) => r && (Array.isArray(r.words) || Array.isArray(r.snippets));

function parseAnalysisResult(content) {
  const candidates = [content, extractJSON(content), cleanJSON(extractJSON(content))];
  for (const c of candidates) {
    try {
      const r = JSON.parse(c);
      if (validResult(r)) return { words: r.words || [], snippets: r.snippets || [] };
      // 策略 4：对象被包进数组（[{words:…},{answer:…}]）→ 逐元素找
      if (Array.isArray(r)) {
        for (const el of r) {
          if (validResult(el) && ((el.words || []).length || (el.snippets || []).length)) {
            return { words: el.words || [], snippets: el.snippets || [] };
          }
        }
      }
    } catch {}
  }
  log(`[Zhipu] ✗ JSON parse failed, content head: ${content.slice(0, 400)}`);
  throw new Error('响应解析失败，模型返回的内容格式不正确');
}

// ---------- 主分析 Prompt（与 macOS 版逐字一致） ----------

function buildWordAnalysisPrompt(categoryTree) {
  return `## 分类体系规则（重要）
用户维护了一个固定的分类体系，每个条目必须归入体系里的一个叶子分类，避免体系越来越乱。
当前分类体系：
${categoryTree || '（空）'}
- 单词只能归入「语言学习」下的分类（按语言），知识片段只能归入「知识片段」下的分类（按领域）。
- \`category\` 只能填体系里**已有**的叶子分类名（原样照抄，如 "英语"、"健身"）。
- 只有当体系里确实没有合适的分类时，\`category\` 给 null，并把建议的新分类名放进 \`suggestedCategory\`（中文，2–4 字，如 "驾驶"、"法律"）；用户会确认是否新建。
- 不要用同义词绕过已有分类（例如已有「健身」就不要建议「运动」「workout」）。

## 标签
- 不使用标签：\`tags\` 一律返回 []（分组一律用分类体系表达）。

这是一张屏幕截图，是外语学习取词场景。图中**红色方框**是用户圈选的目标（通常是 1 个单词或短语），红框外的内容是它的上下文。

## 首先判定红框内容的类型（二选一，不要两者都给）
- 红框内是**一个单词或短语**（大致 ≤5 个词）→ 这是查词：只填 words（就 1 个词条），snippets 给 []。
- 红框内是**一整句话或一段话**（一条规则、一个知识点）→ 这是记知识：只填 snippets（整理成 1 条），words 给 []。段落里的个别生词不要单独立词条。

请完成以下任务：
1. 查词时只分析**红框内**的那个词/短语（不要解释红框外的词），红框外只作语境。
2. 对每个单词提供：
   - 单词原文（词典形式，如动词原形、名词单数；**不要带冠词**——德语名词写 "Vorfahrt" 而不是 "die Vorfahrt"，冠词放进 grammar）。红框里是**短语**时，word 必须是**完整短语**的词典形式（保留全部单词，只把中心词还原原形，如 "Traffic confluences" → "traffic confluence"），**绝不能只取中心词**
   - 音标（国际音标）
   - 语言（de=德语, en=英语, fr=法语等）
   - meaning：该词**常见的 2–4 个义项**，**按词性分组**：每组以词性缩写开头（v. / n. / adj. / adv. / prep.），组内义项用"；"分隔，多个词性之间用 " ｜ " 分隔，如 "v. 规定；开处方 ｜ n. 处方"；只有一个词性也要标前缀（如 "adj. 无阻碍的；畅通的"）。当前语境的词性组放最前
   - contextMeaning：当前语境对应的那个义项（**不带词性前缀**，必须与 meaning 里该义项的写法**逐字一致**，用于高亮）
   - contextSentence：红框所在的**完整原文句子**（从红框外的上下文里补全，不要截断）
   - 该句子的中文翻译（目标词在译文中的对应译法**尽量与 contextMeaning 措辞一致**，用于译文高亮）
   - grammar：**德语必填**——名词给「冠词 + 单数, 复数」如 "der Fahrer, die Fahrer"；动词给「可分/不可分 · 第三人称现在时 · 过去式 · 过去分词（助动词）」如 "trennbar · hält an · hielt an · hat angehalten"；形容词给比较级/最高级。英语等其他语言：不规则变化才填，否则 ""。
   - 难度等级（a1/a2/b1/b2/c1/c2）
3. snippets：仅当第一步判定为"记知识"时填写（交通规则、健身要点、医学常识、题目要点等），整理成 1 条，此时 words 必须是 []。**words 和 snippets 永远二选一，绝不能同时给**——记知识时段落里的生词也不要立词条。
4. 保持简洁，不要输出多余字段。

请严格以 JSON 格式返回，格式如下：
{
  "words": [
    {
      "word": "单词",
      "phonetic": "音标",
      "language": "de",
      "meaning": "义项1；义项2；义项3",
      "contextMeaning": "义项1",
      "contextSentence": "原文句子",
      "contextTranslation": "中文翻译",
      "grammar": "der Fahrer, die Fahrer",
      "difficulty": "b1",
      "tags": [],
      "category": "体系里已有的叶子分类名，或 null",
      "suggestedCategory": "仅当 category 为 null 时给建议的新分类名，否则 null"
    }
  ],
  "snippets": [
    {
      "title": "知识标题",
      "content": "结构化知识内容",
      "sourceContext": "原始上下文",
      "tags": [],
      "category": "体系里已有的叶子分类名，或 null",
      "suggestedCategory": null
    }
  ]
}

只返回 JSON，不要有其他内容。`;
}

/// 主分析：图（dataURL）→ words/snippets
async function analyzeScreenshot(imageDataURL, categoryTree) {
  const message = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageDataURL } },
      { type: 'text', text: buildWordAnalysisPrompt(categoryTree) }
    ]
  };
  const response = await sendRequest([message]);
  const choice = response.choices?.[0];
  const content = choice?.message?.content;
  if (!content || !content.trim()) {
    throw new Error(choice?.finish_reason === 'length'
      ? '模型输出被截断（max_tokens 不足），未返回内容'
      : `模型未返回内容（finish_reason=${choice?.finish_reason || 'unknown'}）`);
  }
  return parseAnalysisResult(content);
}

/// 极速识词（~15 token 输出，2 秒级）：红框是知识点时返回空词头
async function quickExtract(smallImageDataURL) {
  const prompt = `图中红框是用户圈选的目标。先判断类型，再只返回 JSON：
- 红框内是一个单词或短语（大致 ≤5 个词）→ {"word": "词典形式（名词不带冠词；短语保留完整，只把中心词还原原形，如 "Traffic confluences" → "traffic confluence"，不要只取中心词）", "language": "en/de/fr/es/ja/ko/zh"}
- 红框内是一整句话/一段话/一道题（知识点）→ {"word": "", "language": ""}`;
  const message = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: smallImageDataURL } },
      { type: 'text', text: prompt }
    ]
  };
  const response = await sendRequest([message], { maxTokens: 100 });
  const content = response.choices?.[0]?.message?.content || '';
  const q = JSON.parse(extractJSON(content));
  if (typeof q.word !== 'string') throw new Error('quick parse failed');
  return { word: q.word, language: q.language || '' };
}

/// 二段式补全：释义（词性分组）/ 用法 / 搭配 / 例句 / 词根词源（纯文本，快）
async function enrichWord(word, language, meaning = '', sentence = '') {
  const prompt = `为这个外语单词生成学习辅助内容。
单词：${word}（语言代码 ${language}）${meaning ? `\n释义：${meaning}` : ''}${sentence ? `\n语境句：${sentence}` : ''}

只返回 JSON：
{
  "meaning": "释义按词性分组重写：每组以词性缩写开头（v. / n. / adj. / adv. / prep.），组内义项用"；"分隔，组间用 " ｜ " 分隔，如 "v. 规定；开处方 ｜ n. 处方"。**保留上面给出释义的原义项措辞**，只做分组加前缀，不增删义项；没给释义才自己生成 2–4 个义项",
  "usage": "用法分析（易错点、语气，2 句以内；搭配放 collocations 里）",
  "collocations": ["常用搭配 —— 中文", "第二条 —— 中文", "第三条 —— 中文"],
  "examples": ["新造的外语例句 —— 中文翻译", "第二条 —— 中文翻译"],
  "etymology": "词根词源（词根含义 + 来源，1–2 句；太简单的词给 \\"\\"）"
}
例句不要重复语境句，贴近日常或驾考场景。`;
  const response = await sendRequest([{ role: 'user', content: [{ type: 'text', text: prompt }] }]);
  const content = response.choices?.[0]?.message?.content || '';
  const e = JSON.parse(cleanJSON(extractJSON(content)));
  return {
    meaning: e.meaning || null, usage: e.usage || null,
    collocations: Array.isArray(e.collocations) ? e.collocations : null,
    examples: Array.isArray(e.examples) ? e.examples : null,
    etymology: e.etymology || null
  };
}

/// 验证任意提供商的 Key（设置页用）
async function validateKey(key, providerName) {
  const p = PROVIDERS[providerName] || PROVIDERS.zhipu;
  const body = { model: p.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], temperature: 0.1, max_tokens: 5 };
  if (p.supportsThinking) body.thinking = { type: 'disabled' };
  const res = await fetch(p.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (res.status === 401) return { valid: false };
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    return { valid: false, error: msg };
  }
  return { valid: true };
}

module.exports = { analyzeScreenshot, quickExtract, enrichWord, validateKey, isConfigured, currentProviderName };
