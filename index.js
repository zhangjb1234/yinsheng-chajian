// ============================================================
// Fish Audio 语音朗读 · SillyTavern 前端扩展
// • 安装：酒馆「扩展 → 安装扩展程序」粘贴本仓库地址；也可以用酒馆助手外壳脚本加载。
// • 合成：Fish Audio OpenAI 兼容接口（/compat/v1/audio/speech），不需要服务端插件。
// • Key：默认存在酒馆密钥库，由酒馆后端转发；也可选浏览器直连。
// • 语气：朗读稿里写 [happy] [whispering] 这样的 Fish S2 语气标签；可以让 AI 自动加，
//   也可以在「朗读稿编辑器」里朗读前 / 从朗读历史里手动改。加标签的 AI 可以是酒馆当前的模型、
//   某个连接配置，或单独填写的 OpenAI 兼容接口（地址 + Key + 模型）。
//   标签只存在本扩展的朗读稿里，不会写回聊天正文。
// ============================================================
import {
    cleanText, splitText, planSegments, extractVoiceIds, hash53, parseVoiceImport,
    stripEmoTags, hasSpeech, listEmoTags, toSpeechInput, isS1Model, formatTagInsert,
    DEFAULT_AI_PROMPT, buildTagRequest, parseTagResponse, planKeyOf,
    normalizeApiBase, readChatCompletion, readModelList,
} from './text.js';

const VERSION = '2.4.0';
const TAG = '[FishTTS]';

// 在酒馆助手脚本（iframe）里运行时，所有界面都画在酒馆主页面上
const HOST = (() => {
    try { if (window.SillyTavern?.getContext) return window; } catch { /* 跨域时忽略 */ }
    try { if (window.parent?.SillyTavern?.getContext) return window.parent; } catch { /* 跨域时忽略 */ }
    return window;
})();
const IS_SHELL = HOST !== window;
const doc = HOST.document;
const ctx = () => HOST.SillyTavern.getContext();
const MODULE_BASE = new URL('.', import.meta.url).href;

const SETTINGS_KEY = 'fishAudioTts';
const SECRET_KEY = 'api_key_custom_openai_tts'; // 与酒馆自带 TTS 的「OpenAI Compatible」共用
const COMPAT_TTS = 'https://api.fish.audio/compat/v1/audio/speech';
const FISH_API = 'https://api.fish.audio';
const FISH_CDN = 'https://public-platform.r2.fish.audio/';
const NARRATOR_SAME = '__char__';
const MODELS = [
    ['fish-audio/s2.1-pro-free', 'S2.1 Pro 免费版（推荐）'],
    ['fish-audio/s2.1-pro', 'S2.1 Pro（按量计费）'],
    ['fish-audio/s2-pro', 'S2 Pro（按量计费）'],
    ['fish-audio/s1', 'S1（按量计费）'],
    ['custom', '自定义模型 ID'],
];

const DEFAULTS = {
    enabled: true,
    autoRead: true,
    readGreeting: false,
    showMesButton: true,
    showFloat: true,
    floatCollapsed: false,
    floatPos: null,
    keyMode: 'proxy',
    directKey: '',
    model: 'fish-audio/s2.1-pro-free',
    customModel: '',
    speed: 1,
    readMode: 'all',
    skipAsterisk: true,
    stripTags: 'think, thinking, details, StatusBlock, status',
    maxChars: 800,
    testText: '你好呀，这是 Fish Audio 语音试听。今天想聊点什么？',
    voices: [],
    defaultVoice: '',
    useDefaultForUnbound: true,
    bindings: {},
    narratorVoice: NARRATOR_SAME,
    historyLimit: 300,
    cacheMB: 80,
    favOnly: false,            // 我的音色列表只看收藏
    // 语气标签与 AI
    emoEnabled: true,          // 把 [语气标签] 发给 Fish；关掉时合成前去掉所有方括号标签
    editBeforeRead: 'off',     // off：直接读；manual：点 🎧 时先打开编辑器；always：自动朗读也先打开编辑器
    rememberEdits: true,       // 编辑器里「记住这条消息的修改」的默认值
    aiAuto: false,             // 朗读前自动让 AI 加语气标签
    aiSource: 'main',          // main = 酒馆当前连接的模型；custom = 下面的自定义接口；其它值 = 连接配置（Connection Profile）ID
    aiUrl: '',                 // 自定义接口地址（OpenAI 兼容），例如 https://api.deepseek.com/v1
    aiKey: '',                 // 自定义接口的 Key（存在扩展设置里）
    aiModel: '',               // 自定义接口的模型名
    aiVia: 'st',               // st = 经酒馆后端转发（没有跨域问题）；direct = 浏览器直连
    aiDensity: 'normal',
    aiContext: true,           // 把上一条消息的开头发给 AI 帮助判断情绪
    aiPrompt: '',              // 空 = 用内置提示词
    aiMaxTokens: 1500,
    aiTimeout: 60,
};

// 编辑器里的标签面板：[中文名, 发给 Fish 的标签]
const TAG_GROUPS = [
    ['情绪', [
        ['开心', 'happy'], ['兴奋', 'excited'], ['温柔', 'gentle'], ['平静', 'calm'], ['害羞', 'shy'],
        ['撒娇', 'coquettish'], ['调皮', 'teasing'], ['得意', 'proud'], ['自信', 'confident'], ['好奇', 'curious'],
        ['惊讶', 'surprised'], ['紧张', 'nervous'], ['担心', 'worried'], ['害怕', 'scared'], ['尴尬', 'embarrassed'],
        ['委屈', 'aggrieved'], ['难过', 'sad'], ['失望', 'disappointed'], ['感动', 'moved'], ['生气', 'angry'],
        ['不耐烦', 'impatient'], ['冷淡', 'indifferent'], ['嘲讽', 'sarcastic'], ['坚定', 'determined'],
    ]],
    ['语气', [
        ['小声', 'whispering'], ['轻柔', 'soft tone'], ['低沉', 'low voice'], ['颤抖', 'trembling voice'],
        ['慵懒', 'sleepy and lazy'], ['急促', 'in a hurry tone'], ['大喊', 'shouting'], ['尖叫', 'screaming'], ['强调', 'emphasis'],
    ]],
    ['声音', [
        ['大笑', 'laughing'], ['轻笑', 'chuckling'], ['叹气', 'sighing'], ['抽泣', 'sobbing'], ['大哭', 'crying loudly'],
        ['喘气', 'panting'], ['倒吸气', 'gasping'], ['哼', 'humph'], ['打哈欠', 'yawning'], ['清嗓子', 'clear throat'],
    ]],
    ['停顿', [['短停顿', 'break'], ['长停顿', 'long-break']]],
];

// ---------------------------------------------------------------- 通用工具

function S() {
    const es = ctx().extensionSettings;
    if (!es[SETTINGS_KEY] || typeof es[SETTINGS_KEY] !== 'object') es[SETTINGS_KEY] = {};
    const s = es[SETTINGS_KEY];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = JSON.parse(JSON.stringify(v));
    }
    if (!Array.isArray(s.voices)) s.voices = [];
    if (!s.bindings || typeof s.bindings !== 'object') s.bindings = {};
    return s;
}
const save = () => ctx().saveSettingsDebounced();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpsOnly = (u) => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');
const norm = (s) => String(s || '').replace(/\s+/g, '');
const uuid = () => {
    try { return ctx().uuidv4(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
};

function toast(type, msg, title = 'Fish 语音') {
    const t = HOST.toastr;
    if (t && typeof t[type] === 'function') t[type](msg, title);
    else console.log(TAG, type, msg);
}

function el(html) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
}

async function waitFor(cond, timeout = 8000, step = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        try { if (cond()) return true; } catch { /* 继续等 */ }
        await sleep(step);
    }
    return false;
}

function fmtCount(n) {
    n = Number(n) || 0;
    return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}
const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const maskKey = (k) => (k.length > 10 ? `${k.slice(0, 3)}…${k.slice(-4)}` : '••••');

async function confirmBox(text) {
    try {
        const c = ctx();
        if (c.callGenericPopup && c.POPUP_TYPE) {
            return !!(await c.callGenericPopup(esc(text).replace(/\n/g, '<br>'), c.POPUP_TYPE.CONFIRM));
        }
    } catch (e) { console.warn(TAG, e); }
    return HOST.confirm(text);
}

// 生命周期：外壳脚本被关闭时要把东西收拾干净
const cleanups = [];
function onHost(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
}
function onST(evt, fn) {
    if (!evt) return;
    const es = ctx().eventSource;
    es.on(evt, fn);
    cleanups.push(() => { try { es.removeListener(evt, fn); } catch { /* 已移除 */ } });
}
function mount(node, parent) {
    parent.appendChild(node);
    cleanups.push(() => node.remove());
    return node;
}

// ---------------------------------------------------------------- 本地存储（IndexedDB）

let dbPromise = null;
function db() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = HOST.indexedDB.open('fish-tts', 2);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('audioMeta')) d.createObjectStore('audioMeta', { keyPath: 'key' });
                // v2：每条消息的朗读稿（AI 加的标签 / 手动修改），键 = 原始朗读稿指纹
                if (!d.objectStoreNames.contains('scripts')) d.createObjectStore('scripts', { keyPath: 'key' });
            };
            req.onsuccess = () => {
                const d = req.result;
                // 别的标签页升级数据库时让出连接，下次用到时重新打开
                d.onversionchange = () => { d.close(); dbPromise = null; };
                resolve(d);
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB 被旧版本占用：请关闭其它打开着酒馆的标签页后刷新'));
        });
        dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
}
function tx(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        let out;
        const r = fn(t.objectStore(store));
        if (r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    }));
}
const idb = {
    get: (st, k) => tx(st, 'readonly', (s) => s.get(k)),
    put: (st, v) => tx(st, 'readwrite', (s) => s.put(v)),
    del: (st, k) => tx(st, 'readwrite', (s) => s.delete(k)),
    all: (st) => tx(st, 'readonly', (s) => s.getAll()),
    clear: (st) => tx(st, 'readwrite', (s) => s.clear()),
};

async function cacheGet(key) {
    try {
        const row = await idb.get('audio', key);
        if (!row?.buf) return null;
        idb.put('audioMeta', { key, size: row.buf.byteLength, ts: Date.now() }).catch(() => {});
        return new Blob([row.buf], { type: 'audio/mpeg' });
    } catch { return null; }
}
async function cachePut(key, blob) {
    try {
        const buf = await blob.arrayBuffer();
        await idb.put('audio', { key, buf });
        await idb.put('audioMeta', { key, size: buf.byteLength, ts: Date.now() });
        schedulePrune();
    } catch (e) { console.warn(TAG, '音频缓存写入失败', e); }
}
let pruneTimer = 0;
function schedulePrune() {
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(() => pruneAudio().catch((e) => console.warn(TAG, e)), 1500);
}
async function pruneAudio() {
    const metas = await idb.all('audioMeta');
    let total = metas.reduce((a, m) => a + (m.size || 0), 0);
    const max = Math.max(5, Number(S().cacheMB) || 80) * 1048576;
    if (total <= max) return;
    metas.sort((a, b) => a.ts - b.ts);
    for (const m of metas) {
        if (total <= max) break;
        await idb.del('audio', m.key);
        await idb.del('audioMeta', m.key);
        total -= m.size || 0;
    }
}
async function cacheSize() {
    try { return (await idb.all('audioMeta')).reduce((a, m) => a + (m.size || 0), 0); } catch { return 0; }
}

async function addHistory(rec) {
    try {
        await idb.put('history', rec);
        const all = await idb.all('history');
        const limit = Math.max(10, Number(S().historyLimit) || 300);
        if (all.length > limit) {
            all.sort((a, b) => a.ts - b.ts);
            for (const r of all.slice(0, all.length - limit)) await idb.del('history', r.id);
        }
        if (ui.tab === 'history' && isPanelOpen()) renderHistory();
    } catch (e) {
        console.warn(TAG, '写入朗读历史失败', e);
    }
}

// 朗读稿：{ key, source: 'ai'|'manual', texts?: string[], segments?: {voiceId, text}[], ts }
// ai 只记文字（音色跟着当前绑定走）；manual 连音色、增删的段落一起记。
const SCRIPT_LIMIT = 2000;
async function scriptGet(key) {
    if (!key) return null;
    try { return (await idb.get('scripts', key)) || null; } catch { return null; }
}
async function scriptPut(rec) {
    try {
        await idb.put('scripts', { ...rec, ts: Date.now() });
        const all = await idb.all('scripts');
        if (all.length > SCRIPT_LIMIT) {
            all.sort((a, b) => a.ts - b.ts);
            for (const r of all.slice(0, all.length - SCRIPT_LIMIT)) await idb.del('scripts', r.key);
        }
    } catch (e) {
        console.warn(TAG, '保存朗读稿失败', e);
    }
}
async function scriptDel(key) {
    try { await idb.del('scripts', key); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- Fish Audio 接口

const currentModel = () => {
    const s = S();
    return s.model === 'custom' ? (String(s.customModel).trim() || DEFAULTS.model) : s.model;
};

function fishHeaders() {
    const s = S();
    return s.keyMode === 'direct' && s.directKey ? { Authorization: `Bearer ${s.directKey}` } : {};
}

async function fishSearch({ q, page, lang, sort }) {
    const p = new URLSearchParams({ page_size: '20', page_number: String(page), sort_by: sort || 'score' });
    if (q) p.set('title', q);
    if (lang) p.set('language', lang);
    const r = await fetch(`${FISH_API}/model?${p}`);
    if (!r.ok) throw new Error(`声音库搜索失败（HTTP ${r.status}）`);
    return r.json();
}

async function fishModel(id) {
    const r = await fetch(`${FISH_API}/model/${id}`, { headers: fishHeaders() });
    if (!r.ok) throw new Error(`读取音色 ${id} 失败（HTTP ${r.status}）`);
    return r.json();
}

function sanitizeVoice(v) {
    const id = String(v.id || v._id || '').toLowerCase();
    return {
        id,
        name: String(v.name || v.title || `音色 ${id.slice(0, 6)}`).slice(0, 60),
        title: String(v.title || '').slice(0, 80),
        cover: httpsOnly(v.cover),
        sample: httpsOnly(v.sample),
        tags: Array.isArray(v.tags) ? v.tags.map(String).slice(0, 6) : [],
        author: String(v.author || '').slice(0, 40),
        addedAt: Number(v.addedAt) || Date.now(),
        fav: !!v.fav,
    };
}
function modelToVoice(m) {
    return sanitizeVoice({
        id: m._id,
        name: m.title,
        title: m.title,
        cover: m.cover_image ? FISH_CDN + m.cover_image : '',
        sample: m.samples?.[0]?.audio || '',
        tags: m.tags,
        author: m.author?.nickname,
    });
}

function explainError(status, text) {
    const t = String(text || '');
    if (status === 401 || /unauthori|invalid api key|no permission|authorization/i.test(t)) return 'API Key 无效或未设置，请在扩展设置里重新保存';
    if (status === 402 || /balance|insufficient|quota|credit/i.test(t)) return `余额或免费额度不足：${t.slice(0, 120)}`;
    if (status === 429 || /rate limit|too many/i.test(t)) return '请求太频繁，稍等一下再试';
    return `合成失败（HTTP ${status}）${t ? '：' + t.slice(0, 160) : ''}`;
}

async function synthesize(seg, signal) {
    const s = S();
    // seg.input 是真正发给 Fish 的文字（S1 已转成圆括号、关掉语气标签时已去掉标签）；v2.0.x 的历史记录没有这个字段
    const input = seg.input ?? speechInput(seg.text, seg.model);
    const body = { model: seg.model, input, voice: seg.voiceId || '', response_format: 'mp3', speed: seg.speed };
    let r;
    if (s.keyMode === 'direct') {
        if (!s.directKey) throw new Error('还没填写 API Key（浏览器直连模式）');
        r = await fetch(COMPAT_TTS, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.directKey}` },
            body: JSON.stringify(body),
            signal,
        });
    } else {
        r = await fetch(`${HOST.location.origin}/api/openai/custom/generate-voice`, {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ ...body, provider_endpoint: COMPAT_TTS }),
            signal,
        });
        if (r.status === 404) throw new Error('当前酒馆版本没有 OpenAI 兼容 TTS 转发接口：请升级酒馆，或在扩展设置里改用「浏览器直连」');
    }
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(explainError(r.status, t));
    }
    const blob = await r.blob();
    if (!blob.size) throw new Error('Fish 返回了空音频');
    return blob;
}

async function proxyKeyState() {
    try {
        const r = await fetch(`${HOST.location.origin}/api/secrets/read`, { method: 'POST', headers: ctx().getRequestHeaders() });
        if (!r.ok) return null;
        const v = (await r.json())?.[SECRET_KEY];
        if (Array.isArray(v)) {
            const a = v.find((x) => x.active) || v[0];
            return a ? String(a.value || '已保存') : '';
        }
        return v ? '已保存' : '';
    } catch { return null; }
}
async function proxySaveKey(key) {
    const r = await fetch(`${HOST.location.origin}/api/secrets/write`, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ key: SECRET_KEY, value: key, label: 'Fish Audio' }),
    });
    if (!r.ok) throw new Error(`写入酒馆密钥库失败（HTTP ${r.status}）`);
}

// ---------------------------------------------------------------- 音色解析

const voiceById = (id) => S().voices.find((v) => v.id === id);
function voiceName(id) {
    if (id === '' || id === undefined || id === null) return 'Fish 默认声音';
    return voiceById(id)?.name || `音色 ${String(id).slice(0, 6)}`;
}
/** 角色名 → 音色 ID；'' = Fish 默认声音；null = 不朗读 */
function resolveVoice(name) {
    const s = S();
    if (Object.prototype.hasOwnProperty.call(s.bindings, name)) return s.bindings[name];
    return s.useDefaultForUnbound ? s.defaultVoice : null;
}
/** 编辑稿 → 发给 Fish 的文字（S1 转圆括号；关掉语气标签时去掉标签） */
const speechInput = (text, model) => toSpeechInput(text, { model, emoEnabled: S().emoEnabled !== false });

function makeSeg(text, voiceId) {
    const model = currentModel();
    const speed = Math.min(2, Math.max(0.5, Number(S().speed) || 1));
    const input = speechInput(text, model);
    // 没有标签时 input 和 text 相同，缓存键和 v2.0.x 一致，旧缓存还能用
    return { text, input, voiceId, model, speed, key: hash53(`${model}|${voiceId}|${speed}|${input}`) };
}

/** 把段落写进历史记录的展示字段 */
function fillRecord(rec, segments, tagSource) {
    if (!rec) return rec;
    rec.segments = segments;
    rec.text = segments.map((x) => x.text).join('\n').slice(0, 3000);
    rec.voices = [...new Set(segments.map((x) => voiceName(x.voiceId)))];
    rec.tagSource = tagSource || '';
    return rec;
}

const sameItems = (a, b) => a.length === b.length
    && a.every((x, i) => String(x.voiceId ?? '') === String(b[i].voiceId ?? '') && String(x.text).trim() === String(b[i].text).trim());

function currentChatInfo() {
    const c = ctx();
    if (c.groupId) {
        const g = (c.groups || []).find((x) => x.id === c.groupId);
        return { groupId: c.groupId, avatar: null, label: g?.name || '群聊' };
    }
    const ch = c.characters?.[c.characterId];
    return { groupId: null, avatar: ch?.avatar || null, label: ch?.name || '' };
}
function currentNames() {
    const c = ctx();
    const names = new Set();
    if (c.groupId) {
        const g = (c.groups || []).find((x) => x.id === c.groupId);
        for (const av of g?.members || []) {
            const ch = (c.characters || []).find((x) => x.avatar === av);
            if (ch?.name) names.add(ch.name);
        }
    } else if (c.characters?.[c.characterId]?.name) {
        names.add(c.characters[c.characterId].name);
    }
    for (const m of (c.chat || []).slice(-50)) if (m?.name && !m.is_system) names.add(m.name);
    return [...names];
}

/** 把一条聊天消息变成播放任务 */
function buildMessageJob(mesId, manual) {
    const s = S();
    const c = ctx();
    const msg = c.chat?.[mesId];
    const say = (type, text) => { if (manual) toast(type, text); else setStatus(text); };
    if (!msg) return null;
    if (msg.is_system) { say('info', '系统消息不朗读'); return null; }

    const text = cleanText(msg.mes, { stripTags: s.stripTags, skipAsterisk: s.skipAsterisk });
    if (!text || !hasSpeech(text)) { say('info', '这条消息过滤后没有可朗读的文字'); return null; }

    const charVoice = resolveVoice(msg.name);
    const narratorVoice = s.narratorVoice === NARRATOR_SAME ? charVoice : s.narratorVoice;
    const plan = planSegments(splitText(text, s.readMode), { charVoice, narratorVoice, maxChars: s.maxChars });
    if (!plan.length) {
        say('warning', `「${msg.name}」没有绑定音色，也没有开启「未绑定的角色用默认音色」`);
        return null;
    }

    const orig = plan.map((p) => ({ voiceId: p.voiceId, text: p.text }));
    const planKey = planKeyOf(orig);
    const segments = orig.map((p) => makeSeg(p.text, p.voiceId));
    const chat = currentChatInfo();
    const job = {
        label: msg.name,
        speaker: msg.name,
        planKey,
        orig,
        context: s.aiContext ? previousContext(mesId) : '',
        segments,
        record: fillRecord({
            id: uuid(),
            ts: Date.now(),
            chatId: c.getCurrentChatId(),
            groupId: chat.groupId,
            avatar: chat.avatar,
            chatLabel: chat.label,
            mesId: Number(mesId),
            probe: norm(msg.mes).slice(0, 60),
            name: msg.name,
            isUser: !!msg.is_user,
            planKey,
            orig,
        }, segments, ''),
    };
    // 播放前（排到它时）再套用保存的朗读稿 / 调 AI，保证队列顺序不乱
    job.prepare = () => applyScript(job, { allowAi: !!S().aiAuto });
    return job;
}

/** 上一条消息的开头，给 AI 判断情绪用 */
function previousContext(mesId) {
    const chat = ctx().chat || [];
    for (let i = Number(mesId) - 1; i >= 0 && i >= mesId - 5; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const t = cleanText(m.mes, { stripTags: S().stripTags, skipAsterisk: false });
        if (t) return `${m.name}：${t.slice(0, 300)}`;
    }
    return '';
}

function setJobItems(job, items, source) {
    job.segments = items.filter((x) => hasSpeech(x.text)).map((x) => makeSeg(x.text, x.voiceId));
    fillRecord(job.record, job.segments, source);
}

/** 读出这条消息保存过的朗读稿；ai 稿段数和原稿对不上（比如改了朗读模式）就不用 */
async function loadScript(planKey, orig) {
    const sc = await scriptGet(planKey);
    if (!sc) return null;
    if (sc.source === 'manual' && Array.isArray(sc.segments) && sc.segments.length) {
        return { source: 'manual', items: sc.segments.map((x) => ({ voiceId: String(x.voiceId ?? ''), text: String(x.text ?? '') })) };
    }
    if (sc.source === 'ai' && Array.isArray(sc.texts) && sc.texts.length === orig.length) {
        return { source: 'ai', items: orig.map((o, i) => ({ voiceId: o.voiceId, text: String(sc.texts[i] ?? o.text) })) };
    }
    return null;
}

let aiWarnAt = 0;
async function applyScript(job, { allowAi }) {
    if (!job.planKey) return;
    const saved = await loadScript(job.planKey, job.orig);
    if (saved) { setJobItems(job, saved.items, saved.source); return; }
    if (!allowAi) return;
    setStatus(`${job.label} AI 加语气标签中…`);
    try {
        const res = await aiTag(job.orig.map((o) => o.text), { speaker: job.speaker, context: job.context });
        setJobItems(job, job.orig.map((o, i) => ({ voiceId: o.voiceId, text: res.texts[i] })), res.tagged ? 'ai' : '');
        scriptPut({ key: job.planKey, source: 'ai', texts: res.texts });
        if (res.rejected) console.warn(TAG, `AI 改动了 ${res.rejected} 段原文，这些段按原文朗读`);
    } catch (e) {
        console.warn(TAG, 'AI 加语气标签失败，按原文朗读', e);
        if (Date.now() - aiWarnAt > 60000) {
            aiWarnAt = Date.now();
            toast('warning', `AI 加语气标签失败，这次按原文朗读：${e.message}`);
        }
    }
}

// ---------------------------------------------------------------- AI 加语气标签

function connectionProfiles() {
    const list = ctx().extensionSettings?.connectionManager?.profiles;
    return Array.isArray(list) ? list.filter((p) => p && p.id) : [];
}

function aiSourceOptions(selected) {
    const opts = [['main', '酒馆当前连接的模型'], ['custom', '自定义接口（单独填地址、Key、模型）']];
    for (const p of connectionProfiles()) opts.push([p.id, `连接配置：${p.name || p.id}`]);
    if (selected && !opts.some(([id]) => id === selected)) opts.push([selected, '（已删除的连接配置）']);
    return opts.map(([id, name]) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(name)}</option>`).join('');
}

async function aiGenerate(system, user, signal) {
    const s = S();
    const c = ctx();
    const maxTokens = Math.max(200, Number(s.aiMaxTokens) || DEFAULTS.aiMaxTokens);
    if (s.aiSource === 'custom') return customGenerate(system, user, maxTokens, signal);
    if (s.aiSource && s.aiSource !== 'main') {
        const svc = c.ConnectionManagerRequestService;
        if (!svc?.sendRequest) throw new Error('当前酒馆版本不支持按连接配置调用，请把「AI 使用的模型」改成「酒馆当前连接的模型」或「自定义接口」');
        if (!connectionProfiles().some((p) => p.id === s.aiSource)) throw new Error('选择的连接配置已经不存在，请在扩展设置里重新选择');
        const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
        const r = await svc.sendRequest(s.aiSource, messages, maxTokens, { stream: false, extractData: true, includePreset: true, includeInstruct: true });
        return typeof r === 'string' ? r : String(r?.content ?? r?.text ?? '');
    }
    if (typeof c.generateRaw !== 'function') throw new Error('当前酒馆版本没有 generateRaw，请在「AI 使用的模型」里改用「自定义接口」');
    // 新版酒馆的 generateRaw 收一个对象参数（函数 length 为 0）；旧版收位置参数
    const out = c.generateRaw.length === 0
        ? await c.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens, trimNames: false })
        : await c.generateRaw(user, null, false, false, system, maxTokens);
    return String(out ?? '');
}

function withTimeout(promise, ms, message) {
    let timer = 0;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
}

// ---- 自定义接口（OpenAI 兼容 /chat/completions）
// st：经酒馆后端 /api/backends/chat-completions/generate 转发（chat_completion_source = custom），没有跨域问题；
//     Key 放在 custom_include_headers 里，会覆盖酒馆默认加的 Authorization。Key 留空时酒馆用它自己保存的「自定义」Key。
// direct：浏览器直接请求 <地址>/chat/completions，接口必须允许跨域。

function customConfig() {
    const s = S();
    const base = normalizeApiBase(s.aiUrl);
    if (!base) throw new Error('请先在设置里填写自定义接口地址，例如 https://api.deepseek.com/v1');
    const key = String(s.aiKey || '').trim();
    return { base, key, model: String(s.aiModel || '').trim(), via: s.aiVia === 'direct' ? 'direct' : 'st' };
}
const authHeaderYaml = (key) => (key ? JSON.stringify({ Authorization: `Bearer ${key}` }) : '');

function explainAiError(status, data, text) {
    const e = data?.error;
    const msg = String((typeof e === 'string' ? e : e?.message) ?? data?.message ?? '').trim() || String(text || '').trim().slice(0, 200);
    if (status === 401 || status === 403 || /unauthori|forbidden|invalid.{0,20}key|incorrect api key|authenticat/i.test(msg)) return `接口拒绝了 Key（${msg || `HTTP ${status}`}），请检查 Key`;
    if (status === 402 || /payment|balance|insufficient|quota|credit|余额/i.test(msg)) return `余额或额度不足：${msg}`;
    if (status === 429 || /rate.?limit|too many/i.test(msg)) return '请求太频繁，稍等一下再试';
    if (status === 404 || /not.?found|does not exist|no such model|model_not_found/i.test(msg)) return `接口地址或模型名不对（${msg || 'HTTP 404'}）。地址一般以 /v1 结尾，模型名可以点「获取模型列表」选择`;
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|getaddrinfo|socket hang up|certificate/i.test(msg)) return `酒馆连不上这个地址：${msg}`;
    return `AI 接口出错${status ? `（HTTP ${status}）` : ''}${msg ? `：${msg.slice(0, 200)}` : ''}`;
}

async function customFetch(path, init, cfg) {
    try {
        return await fetch(path, init);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (cfg.via === 'direct') throw new Error(`浏览器直连 ${cfg.base} 失败（多半是这个接口不允许跨域）：请把「请求方式」改成「经酒馆后端转发」`);
        throw new Error(`请求酒馆后端失败：${e.message}`);
    }
}

async function readJson(r) {
    const text = await r.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { text, data };
}

async function customGenerate(system, user, maxTokens, signal) {
    const cfg = customConfig();
    if (!cfg.model) throw new Error('请先填写自定义接口的模型名（可以点「获取模型列表」选择）');
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const body = { model: cfg.model, messages, max_tokens: maxTokens, temperature: 0.4, stream: false };
    const r = cfg.via === 'direct'
        ? await customFetch(`${cfg.base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
            body: JSON.stringify(body),
            signal,
        }, cfg)
        : await customFetch(`${HOST.location.origin}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ ...body, chat_completion_source: 'custom', custom_url: cfg.base, custom_include_headers: authHeaderYaml(cfg.key) }),
            signal,
        }, cfg);
    const { text, data } = await readJson(r);
    // 酒馆转发时上游出错也会返回 200 + {error: {message}}
    if (!r.ok || !data || data.error) throw new Error(explainAiError(r.status === 200 ? 0 : r.status, data, data ? '' : text));
    const out = readChatCompletion(data);
    if (!out.text.trim()) {
        if (out.reasoning || out.finish === 'length') throw new Error('AI 只输出了思考过程、没有正文：把「AI 最多回复 token 数」调大，或换一个非推理模型');
        throw new Error('AI 返回了空内容（可能被模型的内容审核拦下了）');
    }
    return out.text;
}

/** 「获取模型列表」：返回模型 ID 数组 */
async function fetchCustomModels() {
    const cfg = customConfig();
    const r = cfg.via === 'direct'
        ? await customFetch(`${cfg.base}/models`, { headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {} }, cfg)
        : await customFetch(`${HOST.location.origin}/api/backends/chat-completions/status`, {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ chat_completion_source: 'custom', custom_url: cfg.base, custom_include_headers: authHeaderYaml(cfg.key) }),
        }, cfg);
    const { text, data } = await readJson(r);
    if (!r.ok || !data || (data.error && !Array.isArray(data.data))) {
        throw new Error(data?.error === true ? '接口没有返回模型列表（地址或 Key 不对，或这个接口不支持 /models）；可以直接手动填写模型名' : explainAiError(r.status, data, text));
    }
    return readModelList(data);
}

/**
 * 让 AI 给每段朗读稿加语气标签。AI 改动了原文的段落保持原样。
 * 结果只用于朗读（存在本扩展的朗读稿库里），不会改聊天正文。
 * @returns {Promise<{texts: string[], tagged: number, rejected: number}>}
 */
async function aiTag(texts, { speaker = '', context = '' } = {}) {
    const s = S();
    const system = String(s.aiPrompt || '').trim() || DEFAULT_AI_PROMPT;
    const user = buildTagRequest(texts, { speaker, density: s.aiDensity, context });
    const sec = Math.min(300, Math.max(10, Number(s.aiTimeout) || DEFAULTS.aiTimeout));
    const ctrl = new AbortController();
    let out;
    try {
        out = await withTimeout(aiGenerate(system, user, ctrl.signal), sec * 1000, `AI 超过 ${sec} 秒没有回复（可以在设置里调大超时）`);
    } catch (e) {
        ctrl.abort();
        throw e;
    }
    if (!String(out ?? '').trim()) throw new Error('AI 返回了空内容（可能被拒绝，或推理模型的 token 不够用）');
    const res = parseTagResponse(out, texts);
    if (res.rejected === texts.length) {
        console.warn(TAG, 'AI 回复无法使用：', out);
        const err = new Error('AI 的回复改动了原文或格式不对，已忽略（可以换个模型，或在设置里调整提示词）');
        err.aiOutput = String(out);
        throw err;
    }
    return res;
}

// ---------------------------------------------------------------- 播放队列

const player = { audio: null, queue: [], current: null, busy: false, status: '空闲' };

function audioEl() {
    if (!player.audio) {
        player.audio = new HOST.Audio();
        player.audio.addEventListener('play', updateFloat);
        player.audio.addEventListener('pause', updateFloat);
    }
    return player.audio;
}

function enqueue(job) {
    player.queue.push(job);
    updateFloat();
    if (!player.busy) runQueue();
}
function playNow(job) {
    stopAll();
    enqueue(job);
}
function stopAll() {
    player.queue.length = 0;
    player.current?.ctrl.abort();
    updateFloat();
}
function skipCurrent() {
    player.current?.ctrl.abort();
}
function togglePause() {
    const a = audioEl();
    if (player.busy) {
        if (a.paused) a.play().catch((e) => toast('warning', `无法播放：${e.message}`));
        else a.pause();
        return;
    }
    // 空闲时点 ▶：朗读最后一条角色消息
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            const job = buildMessageJob(i, true);
            if (job) playNow(job);
            return;
        }
    }
    toast('info', '当前聊天里没有可朗读的角色消息');
}

async function obtainAudio(seg, signal) {
    const cached = await cacheGet(seg.key);
    if (cached) return cached;
    const blob = await synthesize(seg, signal);
    await cachePut(seg.key, blob);
    return blob;
}

function playBlob(blob, signal) {
    return new Promise((resolve, reject) => {
        const a = audioEl();
        const url = URL.createObjectURL(blob);
        const cleanup = () => {
            a.onended = null;
            a.onerror = null;
            signal.removeEventListener('abort', onAbort);
            URL.revokeObjectURL(url);
        };
        const onAbort = () => { a.pause(); cleanup(); reject(new DOMException('已停止', 'AbortError')); };
        a.onended = () => { cleanup(); resolve(); };
        a.onerror = () => { cleanup(); reject(new Error('音频播放失败')); };
        signal.addEventListener('abort', onAbort);
        a.src = url;
        a.play().catch((err) => {
            if (err?.name === 'NotAllowedError') {
                setStatus('浏览器拦截了自动播放，点 ▶ 继续');
            } else if (err?.name !== 'AbortError') {
                cleanup();
                reject(err);
            }
        });
    });
}

async function playJob(job) {
    const signal = job.ctrl.signal;
    if (job.prepare) {
        await job.prepare(signal);
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    }
    if (!job.segments.length) return;
    const pending = [];
    const fetchSeg = (i) => (pending[i] ??= obtainAudio(job.segments[i], signal));
    for (let i = 0; i < job.segments.length; i++) {
        const n = job.segments.length > 1 ? ` ${i + 1}/${job.segments.length}` : '';
        setStatus(`${job.label} 合成中${n}…`);
        const blob = await fetchSeg(i);
        if (i + 1 < job.segments.length) fetchSeg(i + 1).catch(() => {});
        if (i === 0 && job.record) addHistory(job.record);
        setStatus(`${job.label} 朗读中${n}`);
        await playBlob(blob, signal);
    }
}

async function runQueue() {
    player.busy = true;
    while (player.queue.length) {
        const job = player.queue.shift();
        job.ctrl = new AbortController();
        player.current = job;
        updateFloat();
        try {
            await playJob(job);
        } catch (e) {
            if (!job.ctrl.signal.aborted && e?.name !== 'AbortError') {
                console.error(TAG, e);
                setStatus(`出错：${e.message}`);
                toast('error', e.message);
            }
        }
        player.current = null;
    }
    player.busy = false;
    if (!/^出错/.test(player.status)) setStatus('空闲');
    updateFloat();
}

function setStatus(text) {
    player.status = text;
    const s = floatEl?.querySelector('.fishtts-float-status');
    if (s) { s.textContent = text; s.title = text; }
}

// ---------------------------------------------------------------- 自动朗读 & 消息按钮

function onMessageReceived(mesId, type) {
    const s = S();
    if (!s.enabled || !s.autoRead) return;
    if (type === 'impersonate') return;
    if (type === 'first_message' && !s.readGreeting) return;
    const msg = ctx().chat?.[mesId];
    if (!msg || msg.is_user || msg.is_system) return;
    // 「自动朗读也先打开编辑器」：编辑器空着才弹；正在编辑别的消息时这条照常排队朗读
    if (s.editBeforeRead === 'always' && edEl && !isEditorOpen()) {
        openEditorForMessage(Number(mesId), { auto: true }).catch((e) => console.error(TAG, e));
        return;
    }
    const job = buildMessageJob(Number(mesId), false);
    if (job) enqueue(job);
}

/** 消息上的 🎧：按设置直接朗读或先打开编辑器 */
function readMessage(mesId) {
    if (S().editBeforeRead !== 'off' && edEl) {
        openEditorForMessage(mesId).catch((e) => toast('error', e.message));
        return;
    }
    const job = buildMessageJob(mesId, true);
    if (job) playNow(job);
}

let decorateTimer = 0;
function decorateSoon() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateMessages, 120);
}
function decorateMessages() {
    const s = S();
    if (!s.enabled || !s.showMesButton) {
        doc.querySelectorAll('.fishtts-mes-btn, .fishtts-mes-edit').forEach((b) => b.remove());
        return;
    }
    doc.querySelectorAll('#chat .mes').forEach((mes) => {
        const box = mes.querySelector('.extraMesButtons');
        if (!box || box.querySelector('.fishtts-mes-btn')) return;
        const edit = doc.createElement('div');
        edit.className = 'mes_button fishtts-mes-edit fa-solid fa-pen-to-square interactable';
        edit.title = 'Fish：编辑语气标签后朗读';
        edit.tabIndex = 0;
        box.prepend(edit);
        const b = doc.createElement('div');
        b.className = 'mes_button fishtts-mes-btn fa-solid fa-headphones interactable';
        b.title = 'Fish 朗读这条';
        b.tabIndex = 0;
        box.prepend(b);
    });
}

// ---------------------------------------------------------------- 定位历史消息

function findMessageIndex(rec) {
    const chat = ctx().chat || [];
    const probe = rec.probe;
    if (!probe) return chat[rec.mesId] ? { index: rec.mesId, otherSwipe: false } : null;
    const inMes = (m) => m && norm(m.mes).includes(probe);
    const inSwipes = (m) => m && Array.isArray(m.swipes) && m.swipes.some((sw) => norm(sw).includes(probe));
    if (inMes(chat[rec.mesId])) return { index: rec.mesId, otherSwipe: false };
    let best = null;
    let dist = Infinity;
    chat.forEach((m, i) => {
        const hit = inMes(m) ? 1 : (inSwipes(m) ? 2 : 0);
        if (!hit) return;
        const d = Math.abs(i - rec.mesId) + (hit === 2 ? 0.5 : 0);
        if (d < dist) { dist = d; best = { index: i, otherSwipe: hit === 2 }; }
    });
    return best;
}

async function ensureRendered(index) {
    for (let i = 0; i < 80; i++) {
        const node = doc.querySelector(`#chat .mes[mesid="${index}"]`);
        if (node) return node;
        const more = doc.getElementById('show_more_messages');
        if (!more) return null;
        more.click();
        await sleep(250);
    }
    return null;
}

async function locate(rec) {
    try {
        if (ctx().getCurrentChatId() !== rec.chatId) {
            setStatus(`正在打开「${rec.chatLabel}」的聊天…`);
            if (rec.groupId) {
                if (!(ctx().groups || []).some((g) => g.id === rec.groupId)) throw new Error('这个群聊已经不存在');
                await ctx().openGroupChat(rec.groupId, rec.chatId);
            } else {
                const idx = (ctx().characters || []).findIndex((ch) => ch.avatar === rec.avatar);
                if (idx < 0) throw new Error('这个角色卡已经不存在');
                if (String(ctx().characterId) !== String(idx) || ctx().groupId) {
                    await ctx().selectCharacterById(idx, { switchMenu: false });
                    await waitFor(() => String(ctx().characterId) === String(idx), 8000);
                }
                if (ctx().getCurrentChatId() !== rec.chatId) await ctx().openCharacterChat(rec.chatId);
            }
            if (!(await waitFor(() => ctx().getCurrentChatId() === rec.chatId, 10000))) throw new Error('聊天没有打开');
            await sleep(400);
        }
    } catch (e) {
        toast('warning', `没能自动打开聊天「${rec.chatLabel} / ${rec.chatId}」：${e.message}。请手动打开后再点定位。`);
        setStatus(player.busy ? player.status : '空闲');
        return;
    }

    const hit = findMessageIndex(rec);
    if (!hit) { toast('warning', '原消息已被删除或修改，找不到对应楼层'); return; }
    const node = await ensureRendered(hit.index);
    if (!node) { toast('warning', `找到了第 ${hit.index} 楼，但它没有显示在页面上`); return; }
    if (HOST.innerWidth < 760) closePanel();
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('fishtts-flash');
    setTimeout(() => node.classList.remove('fishtts-flash'), 2600);
    if (hit.otherSwipe) toast('info', '这次朗读来自该楼层的另一个 swipe（左右滑动可以找到）');
    if (!player.busy) setStatus('空闲');
}

// ---------------------------------------------------------------- 悬浮控制条

let floatEl = null;

function buildFloat() {
    floatEl = mount(el(`
<div id="fishtts-float" class="fishtts-float" style="position:fixed;right:16px;bottom:90px;z-index:3000">
  <div class="fishtts-float-handle" title="Fish 语音（点击展开/收起，按住可拖动）"><i class="fa-solid fa-headphones"></i></div>
  <div class="fishtts-float-body">
    <span class="fishtts-float-status">空闲</span>
    <button type="button" data-act="playPause" title="播放/暂停（空闲时朗读最后一条）"><i class="fa-solid fa-play"></i></button>
    <button type="button" data-act="skip" title="跳过当前"><i class="fa-solid fa-forward-step"></i></button>
    <button type="button" data-act="stop" title="停止并清空队列"><i class="fa-solid fa-stop"></i></button>
    <button type="button" data-act="openPanel" title="打开语音面板"><i class="fa-solid fa-list"></i></button>
  </div>
</div>`), doc.body);

    const handle = floatEl.querySelector('.fishtts-float-handle');
    let start = null;
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
        const r = floatEl.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
        dragging = false;
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) < 6) return;
        dragging = true;
        placeFloat(start.left + dx, start.top + dy);
    });
    handle.addEventListener('pointerup', () => {
        if (!start) return;
        if (dragging) {
            const r = floatEl.getBoundingClientRect();
            S().floatPos = { x: Math.round(r.left), y: Math.round(r.top) };
        } else {
            S().floatCollapsed = !S().floatCollapsed;
        }
        save();
        start = null;
        updateFloat();
    });
    handle.addEventListener('pointercancel', () => { start = null; });
    floatEl.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'playPause') togglePause();
        else if (act === 'skip') skipCurrent();
        else if (act === 'stop') { stopAll(); setStatus('空闲'); }
        else if (act === 'openPanel') openPanel();
    });
    onHost(HOST, 'resize', () => updateFloat());
    // 样式表加载完、字体到位、折叠/展开时悬浮条尺寸会变，按新尺寸重新摆一次，避免被挤到屏幕外
    if (HOST.ResizeObserver) {
        const ro = new HOST.ResizeObserver(() => { if (!start) updateFloat(); });
        ro.observe(floatEl);
        cleanups.push(() => ro.disconnect());
    }
    HOST.requestAnimationFrame?.(() => updateFloat());
    updateFloat();
}

function defaultFloatPosition() {
    if (!floatEl) return;
    floatEl.style.left = 'auto';
    floatEl.style.top = 'auto';
    floatEl.style.right = '16px';
    floatEl.style.bottom = '90px';
}

function placeFloat(x, y) {
    if (!floatEl || floatEl.hidden) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { defaultFloatPosition(); return; }
    const vw = HOST.innerWidth;
    const vh = HOST.innerHeight;
    if (!vw || !vh) return;
    const r = floatEl.getBoundingClientRect();
    const w = Math.min(r.width || 48, vw - 8);
    const h = Math.min(r.height || 48, vh - 8);
    const cx = Math.min(Math.max(4, x), vw - w - 4);
    const cy = Math.min(Math.max(4, y), vh - h - 4);
    floatEl.style.left = `${Math.round(cx)}px`;
    floatEl.style.top = `${Math.round(cy)}px`;
    floatEl.style.right = 'auto';
    floatEl.style.bottom = 'auto';
}

function resetFloat() {
    const s = S();
    s.floatPos = null;
    s.floatCollapsed = false;
    s.showFloat = true;
    save();
    defaultFloatPosition();
    const box = settingsEl?.querySelector('[data-setting="showFloat"]');
    if (box) box.checked = true;
    updateFloat();
    if (s.enabled) toast('success', '悬浮条已经回到右下角');
    else toast('warning', '悬浮条位置已重置。扩展现在是停用状态，勾选「启用」后才会显示');
}

function updateFloat() {
    if (!floatEl) return;
    const s = S();
    floatEl.hidden = !(s.enabled && s.showFloat);
    floatEl.classList.toggle('fishtts-collapsed', !!s.floatCollapsed);
    floatEl.classList.toggle('fishtts-busy', player.busy);
    const playing = player.busy && player.audio && !player.audio.paused;
    const icon = floatEl.querySelector('[data-act="playPause"] i');
    if (icon) icon.className = `fa-solid ${playing ? 'fa-pause' : 'fa-play'}`;
    const q = player.queue.length;
    floatEl.querySelector('.fishtts-float-handle').dataset.count = q ? String(q) : '';
    if (s.floatPos) placeFloat(Number(s.floatPos.x), Number(s.floatPos.y));
    else defaultFloatPosition();
}

// ---------------------------------------------------------------- 朗读稿编辑器（朗读前 / 历史记录里改语气标签）

let edEl = null;
const ed = { ctx: null, lastTa: null, busy: false, token: 0, touched: false, aiApplied: false };
const eref = (name) => edEl.querySelector(`[data-ref="${name}"]`);
const isEditorOpen = () => !!edEl && !edEl.classList.contains('fishtts-hidden');

function buildEditor() {
    const groups = TAG_GROUPS.map(([label, tags]) => `
      <div class="fishtts-ed-group"><span class="fishtts-ed-glabel">${esc(label)}</span>${tags.map(([zh, tag]) => `<button type="button" class="fishtts-ed-chip" data-act="edTag" data-tag="${esc(tag)}" title="[${esc(tag)}]">${esc(zh)}</button>`).join('')}</div>`).join('');
    edEl = mount(el(`
<div id="fishtts-editor" class="fishtts-panel fishtts-editor fishtts-hidden" role="dialog" aria-label="Fish 朗读稿编辑器">
  <div class="fishtts-backdrop" data-act="edClose"></div>
  <div class="fishtts-window fishtts-ed-window">
    <div class="fishtts-head">
      <div class="fishtts-title"><i class="fa-solid fa-pen-to-square"></i> 朗读稿 <small data-ref="edTitle"></small></div>
      <button type="button" class="fishtts-icon" data-act="edClose" title="关闭"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="fishtts-body">
      <small class="fishtts-dim fishtts-ed-note" data-ref="edNote"></small>
      <details class="fishtts-ed-tags" open>
        <summary>语气标签 <span class="fishtts-dim">（先点到要加标签的位置，再点下面的标签插入）</span></summary>
        ${groups}
        <div class="fishtts-row">
          <input class="text_pole fishtts-grow" data-ref="edCustom" placeholder="自定义标签，例如 softly, teasing 或 voice breaking">
          <button type="button" class="menu_button" data-act="edTagCustom"><i class="fa-solid fa-plus"></i> 插入</button>
        </div>
      </details>
      <div class="fishtts-list" data-ref="edSegs"></div>
      <div class="fishtts-row"><button type="button" class="menu_button" data-act="edAdd"><i class="fa-solid fa-plus"></i> 添加一段</button></div>
    </div>
    <div class="fishtts-ed-foot">
      <div class="fishtts-row">
        <button type="button" class="menu_button" data-act="edAi" title="让 AI 在原文里插入语气标签，不改动文字（已有标签会保留）"><i class="fa-solid fa-wand-magic-sparkles"></i> <span>AI 加标签</span></button>
        <button type="button" class="menu_button" data-act="edClear" title="去掉所有 [标签]"><i class="fa-solid fa-eraser"></i> 清除标签</button>
        <button type="button" class="menu_button" data-act="edReset" title="回到消息原文"><i class="fa-solid fa-rotate-left"></i> 还原原文</button>
        <label class="checkbox_label" data-ref="edRememberBox"><input type="checkbox" data-ref="edRemember"> 记住这条消息的修改</label>
      </div>
      <div class="fishtts-row fishtts-ed-main">
        <button type="button" class="menu_button" data-act="edClose">取消</button>
        <button type="button" class="menu_button" data-act="edSave"><i class="fa-solid fa-floppy-disk"></i> 只保存</button>
        <button type="button" class="menu_button fishtts-primary" data-act="edPlay"><i class="fa-solid fa-play"></i> 朗读</button>
      </div>
    </div>
  </div>
</div>`), doc.body);

    edEl.addEventListener('click', onEditorClick);
    edEl.addEventListener('focusin', (e) => { if (e.target.classList?.contains('fishtts-ed-text')) ed.lastTa = e.target; });
    edEl.addEventListener('input', (e) => { if (e.target.classList?.contains('fishtts-ed-text')) ed.touched = true; });
    edEl.addEventListener('change', (e) => { if (e.target.classList?.contains('fishtts-ed-voice')) ed.touched = true; });
    eref('edCustom').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); insertCustomTag(); }
    });
}

function renderEdSegs(items) {
    eref('edSegs').innerHTML = items.map((x, i) => `
<div class="fishtts-ed-seg">
  <div class="fishtts-ed-seghead">
    <span class="fishtts-chip" data-ref="segNo">第 ${i + 1} 段</span>
    <select class="text_pole fishtts-ed-voice" title="这一段用的音色">${voiceOptions(String(x.voiceId ?? ''))}</select>
    <button type="button" class="menu_button" data-act="edPreview" title="只试听这一段（会消耗额度）"><i class="fa-solid fa-volume-high"></i></button>
    <button type="button" class="menu_button" data-act="edDel" title="删除这一段（不朗读）"><i class="fa-solid fa-trash-can"></i></button>
  </div>
  <textarea class="text_pole fishtts-ed-text" rows="${Math.min(10, Math.max(2, Math.ceil(String(x.text).length / 42)))}">${esc(x.text)}</textarea>
</div>`).join('') || '<div class="fishtts-empty">没有段落了，点「添加一段」。</div>';
    ed.lastTa = null;
}

function renumberEdSegs() {
    edEl.querySelectorAll('.fishtts-ed-seg').forEach((row, i) => { row.querySelector('[data-ref="segNo"]').textContent = `第 ${i + 1} 段`; });
    if (!edEl.querySelector('.fishtts-ed-seg')) renderEdSegs([]);
}

function edItems() {
    return [...edEl.querySelectorAll('.fishtts-ed-seg')].map((row) => ({
        voiceId: row.querySelector('.fishtts-ed-voice').value,
        text: row.querySelector('.fishtts-ed-text').value.trim(),
    }));
}

/**
 * @param {{title: string, speaker: string, context?: string, planKey?: string, orig: {voiceId: string, text: string}[],
 *          items: {voiceId: string, text: string}[], record?: object|null, fromHistory?: boolean, note?: string,
 *          loadedSource?: string, autoAi?: boolean}} opts
 */
function openEditor(opts) {
    if (!edEl) { toast('error', '编辑器没有初始化成功，请刷新页面'); return; }
    ed.ctx = opts;
    ed.token++;
    ed.touched = false;
    ed.aiApplied = false;
    eref('edTitle').textContent = opts.title || '';
    const notes = [];
    if (opts.note) notes.push(opts.note);
    if (opts.fromHistory) notes.push('改完点「朗读」会重新合成并更新这条历史记录。');
    if (S().emoEnabled === false) notes.push('提示：设置里关掉了「把语气标签发给 Fish」，合成前会去掉所有标签。');
    else if (isS1Model(currentModel())) notes.push('当前模型是 S1：合成时会把 [标签] 自动换成 (标签)，S1 只认官方固定标签，自然语言描述可能无效。');
    eref('edNote').textContent = notes.join(' ');
    eref('edNote').hidden = !notes.length;
    eref('edRemember').checked = !!S().rememberEdits;
    eref('edRememberBox').hidden = !opts.planKey;
    renderEdSegs(opts.items);
    setEdBusy(false);
    edEl.classList.remove('fishtts-hidden');
    if (opts.autoAi) runEditorAi();
}

async function closeEditor(force = false) {
    if (!isEditorOpen()) return;
    if (!force && ed.touched && !(await confirmBox('放弃这次修改？'))) return;
    edEl.classList.add('fishtts-hidden');
    ed.token++;
    ed.ctx = null;
}

async function openEditorForMessage(mesId, { auto = false } = {}) {
    const job = buildMessageJob(Number(mesId), !auto);
    if (!job) return;
    const saved = await loadScript(job.planKey, job.orig);
    if (auto && isEditorOpen()) { enqueue(job); return; } // 等待期间用户已经打开了别的编辑
    openEditor({
        title: `${job.label} · #${mesId}`,
        speaker: job.speaker,
        context: job.context,
        planKey: job.planKey,
        orig: job.orig,
        items: saved?.items || job.orig,
        loadedSource: saved?.source || '',
        record: job.record,
        fromHistory: false,
        note: saved ? (saved.source === 'manual' ? '已载入你上次保存的修改。' : '已载入上次 AI 加的标签。') : (auto ? '新回复：确认后点「朗读」。' : ''),
        autoAi: !saved && !!S().aiAuto,
    });
}

function openEditorForRecord(rec) {
    const segs = Array.isArray(rec.segments) ? rec.segments : [];
    // v2.0.x 的记录没有 orig：那时还不能编辑，记录里的稿子就是原文
    const orig = Array.isArray(rec.orig) && rec.orig.length ? rec.orig : segs.map((x) => ({ voiceId: String(x.voiceId ?? ''), text: String(x.text ?? '') }));
    const planKey = rec.planKey || planKeyOf(orig);
    openEditor({
        title: `${rec.name} · 历史记录 #${rec.mesId}`,
        speaker: rec.name,
        context: '',
        planKey,
        orig,
        items: segs.map((x) => ({ voiceId: String(x.voiceId ?? ''), text: String(x.text ?? '') })),
        loadedSource: rec.tagSource || '',
        record: { ...rec, planKey, orig },
        fromHistory: true,
    });
}

function setEdBusy(busy, label) {
    const b = edEl.querySelector('[data-act="edAi"]');
    b.disabled = busy;
    b.querySelector('span').textContent = busy ? (label || 'AI 处理中…') : 'AI 加标签';
    b.querySelector('i').className = busy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles';
}

async function runEditorAi() {
    if (ed.busy) return;
    const items = edItems();
    if (!items.some((x) => hasSpeech(x.text))) { toast('info', '没有可以加标签的文字'); return; }
    const token = ed.token;
    ed.busy = true;
    setEdBusy(true, 'AI 加标签中…');
    try {
        const res = await aiTag(items.map((x) => x.text), { speaker: ed.ctx?.speaker, context: ed.ctx?.context });
        if (token !== ed.token || !isEditorOpen()) return; // 编辑器已经关了或换了一条
        edEl.querySelectorAll('.fishtts-ed-text').forEach((ta, i) => { if (res.texts[i] !== undefined) ta.value = res.texts[i]; });
        ed.aiApplied = true;
        if (res.rejected) toast('warning', `AI 加好了标签；有 ${res.rejected} 段 AI 改动了原文，这几段保持原样`);
        else if (!res.tagged) toast('info', 'AI 觉得这段不需要加标签');
        else toast('success', 'AI 已加好语气标签，可以再手动调整');
    } catch (e) {
        if (token === ed.token) toast('error', `AI 加标签失败：${e.message}`);
    } finally {
        ed.busy = false;
        if (edEl) setEdBusy(false);
    }
}

function insertTag(tag) {
    let ta = ed.lastTa;
    if (!ta || !ta.isConnected) ta = edEl.querySelector('.fishtts-ed-text');
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const text = formatTagInsert(tag, ta.value.slice(0, start), ta.value.slice(end));
    if (!text) return;
    ta.focus();
    if (typeof ta.setRangeText === 'function') ta.setRangeText(text, start, end, 'end');
    else ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ed.lastTa = ta;
    ed.touched = true;
}

function insertCustomTag() {
    const input = eref('edCustom');
    const tag = input.value.replace(/[[\]\n]/g, ' ').trim().slice(0, 40);
    if (!tag) { toast('info', '先输入标签内容，例如 softly'); return; }
    insertTag(tag);
    input.value = '';
}

/** 编辑器里的修改：落到朗读稿库 / 历史记录，按需朗读 */
async function commitEditor({ play }) {
    const c = ed.ctx;
    if (!c) return;
    const items = edItems().filter((x) => hasSpeech(x.text));
    if (!items.length) { toast('warning', '没有可以朗读的文字'); return; }
    const remember = !!c.planKey && eref('edRemember').checked;
    const changed = !sameItems(items, c.orig);
    const source = !changed ? '' : (ed.touched ? 'manual' : (ed.aiApplied ? 'ai' : (c.loadedSource || 'manual')));

    if (!play && !remember && !c.fromHistory) {
        toast('warning', '没有勾选「记住这条消息的修改」，只保存的话什么都不会留下。要么勾上，要么直接点「朗读」');
        return;
    }
    if (remember) {
        if (!changed) await scriptDel(c.planKey);
        else if (source === 'ai' && items.length === c.orig.length && items.every((x, i) => x.voiceId === String(c.orig[i].voiceId ?? ''))) {
            await scriptPut({ key: c.planKey, source: 'ai', texts: items.map((x) => x.text) });
        } else {
            await scriptPut({ key: c.planKey, source: 'manual', segments: items });
        }
    }

    const segments = items.map((x) => makeSeg(x.text, x.voiceId));
    const rec = c.record ? fillRecord({ ...c.record, editedAt: changed ? Date.now() : c.record.editedAt }, segments, source) : null;
    if (rec && !c.fromHistory) rec.ts = Date.now();
    await closeEditor(true);

    if (play) {
        playNow({ label: c.speaker || '朗读', segments, record: rec });
    } else if (rec && c.fromHistory) {
        await idb.put('history', rec);
        if (isPanelOpen() && ui.tab === 'history') renderHistory();
        toast('success', remember ? '已更新历史记录，下次朗读这条消息也会用这份稿子（重播时才会重新合成）' : '已更新历史记录（重播时才会重新合成）');
    } else {
        toast('success', '已保存。下次朗读这条消息会使用修改后的稿子');
    }
}

async function onEditorClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !edEl.contains(btn)) return;
    const act = btn.dataset.act;
    try {
        switch (act) {
            case 'edClose': await closeEditor(); break;
            case 'edTag': insertTag(btn.dataset.tag); break;
            case 'edTagCustom': insertCustomTag(); break;
            case 'edAi': await runEditorAi(); break;
            case 'edClear':
                edEl.querySelectorAll('.fishtts-ed-text').forEach((ta) => { ta.value = stripEmoTags(ta.value); });
                ed.touched = true;
                break;
            case 'edReset':
                renderEdSegs(ed.ctx?.orig || []);
                ed.touched = false;
                ed.aiApplied = false;
                break;
            case 'edAdd': {
                const items = edItems();
                const voiceId = items.length ? items[items.length - 1].voiceId : (resolveVoice(ed.ctx?.speaker) ?? S().defaultVoice);
                renderEdSegs([...items, { voiceId, text: '' }]);
                const all = edEl.querySelectorAll('.fishtts-ed-text');
                all[all.length - 1]?.focus();
                ed.touched = true;
                break;
            }
            case 'edDel':
                btn.closest('.fishtts-ed-seg')?.remove();
                renumberEdSegs();
                ed.touched = true;
                break;
            case 'edPreview': {
                const row = btn.closest('.fishtts-ed-seg');
                const text = row.querySelector('.fishtts-ed-text').value.trim();
                if (!hasSpeech(text)) { toast('info', '这一段没有可以读的文字'); break; }
                playNow({ label: '试听这一段', segments: [makeSeg(text, row.querySelector('.fishtts-ed-voice').value)], record: null });
                break;
            }
            case 'edSave': await commitEditor({ play: false }); break;
            case 'edPlay': await commitEditor({ play: true }); break;
            default: break;
        }
    } catch (err) {
        console.error(TAG, err);
        toast('error', err.message || String(err));
    }
}

// ---------------------------------------------------------------- 语音面板

const ui = { tab: 'discover', results: [], page: 1, hasMore: false, searching: false, historyShown: 100 };
let historyFiltered = []; // 朗读历史当前筛选出的记录（供「导出全部 MP3」使用）
let panelEl = null;
const ref = (name) => panelEl.querySelector(`[data-ref="${name}"]`);
const isPanelOpen = () => panelEl && !panelEl.classList.contains('fishtts-hidden');
let previewAudio = null;

function buildPanel() {
    panelEl = mount(el(`
<div id="fishtts-panel" class="fishtts-panel fishtts-hidden" role="dialog" aria-label="Fish 语音面板">
  <div class="fishtts-backdrop" data-act="close"></div>
  <div class="fishtts-window">
    <div class="fishtts-head">
      <div class="fishtts-title"><i class="fa-solid fa-headphones"></i> Fish 语音 <small>v${VERSION}</small></div>
      <div class="fishtts-tabs">
        <button type="button" data-tab="discover">发现音色</button>
        <button type="button" data-tab="mine">我的音色</button>
        <button type="button" data-tab="bind">角色绑定</button>
        <button type="button" data-tab="history">朗读历史</button>
      </div>
      <button type="button" class="fishtts-icon" data-act="close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="fishtts-body">

      <section data-pane="discover">
        <form class="fishtts-toolbar" data-ref="searchForm">
          <input type="search" class="text_pole" data-ref="q" placeholder="搜索 Fish 声音库：角色名、温柔、旁白…">
          <select class="text_pole" data-ref="lang">
            <option value="">全部语言</option><option value="zh" selected>中文</option><option value="ja">日语</option><option value="en">英语</option>
          </select>
          <select class="text_pole" data-ref="sort">
            <option value="score">综合热门</option><option value="task_count">使用最多</option><option value="created_at">最新</option>
          </select>
          <button type="submit" class="menu_button">搜索</button>
        </form>
        <div class="fishtts-grid" data-ref="results"></div>
        <div class="fishtts-foot"><span data-ref="discoverInfo"></span><button type="button" class="menu_button" data-act="more" hidden>加载更多</button></div>
      </section>

      <section data-pane="mine">
        <div class="fishtts-box">
          <textarea class="text_pole" data-ref="importText" rows="2" placeholder="粘贴 fish.audio 音色链接或 32 位音色 ID，可以一次粘贴多个"></textarea>
          <div class="fishtts-row">
            <button type="button" class="menu_button" data-act="importIds"><i class="fa-solid fa-plus"></i> 添加</button>
            <button type="button" class="menu_button" data-act="importFile"><i class="fa-solid fa-file-import"></i> 导入配置</button>
            <button type="button" class="menu_button" data-act="export"><i class="fa-solid fa-file-export"></i> 导出配置</button>
            <input type="file" accept=".json,application/json" data-ref="file" hidden>
          </div>
          <small class="fishtts-dim">导入支持本扩展导出的配置，以及旧版服务端插件的 voices.json。想用自己的声音：先在 fish.audio 网站上传素材创建音色，再把链接贴到这里。</small>
        </div>
        <div class="fishtts-row">
          <span>默认音色</span><select class="text_pole fishtts-grow" data-ref="defaultVoice"></select>
          <label class="checkbox_label"><input type="checkbox" data-ref="useDefault"> 未绑定的角色用默认音色</label>
          <label class="checkbox_label"><input type="checkbox" data-ref="favOnly"> ♥ 只看收藏</label>
        </div>
        <div class="fishtts-list" data-ref="mineList"></div>
      </section>

      <section data-pane="bind">
        <small class="fishtts-dim">角色名要和聊天里显示的名字完全一致。也可以给你自己的人设名绑定音色，用消息上的 <i class="fa-solid fa-headphones"></i> 手动朗读，或点 <i class="fa-solid fa-pen-to-square"></i> 先加语气标签再读。</small>
        <div class="fishtts-row">
          <input class="text_pole fishtts-grow" data-ref="bindName" list="fishtts-names" placeholder="角色名">
          <datalist id="fishtts-names"></datalist>
          <select class="text_pole fishtts-grow" data-ref="bindVoice"></select>
          <button type="button" class="menu_button" data-act="bindAdd">绑定</button>
          <button type="button" class="menu_button" data-act="bindCurrent">添加当前聊天的角色</button>
        </div>
        <div class="fishtts-row">
          <span>旁白音色</span><select class="text_pole fishtts-grow" data-ref="narrator"></select>
          <small class="fishtts-dim">只在「分角色 + 旁白」朗读模式下使用</small>
        </div>
        <div class="fishtts-list" data-ref="bindList"></div>
      </section>

      <section data-pane="history">
        <div class="fishtts-toolbar">
          <input type="search" class="text_pole" data-ref="hq" placeholder="搜索朗读内容或角色名">
          <label class="checkbox_label"><input type="checkbox" data-ref="hCurrent"> 只看当前聊天</label>
          <button type="button" class="menu_button" data-act="historyClear"><i class="fa-solid fa-trash-can"></i> 清空</button>
          <button type="button" class="menu_button" data-act="hExportAll" title="把当前筛选出的记录逐个导出为 MP3 文件"><i class="fa-solid fa-file-arrow-down"></i> 导出全部 MP3</button>
        </div>
        <small class="fishtts-dim" data-ref="hInfo"></small>
        <div class="fishtts-list" data-ref="historyList"></div>
        <div class="fishtts-foot"><button type="button" class="menu_button" data-act="hMore" hidden>显示更多</button></div>
      </section>

    </div>
  </div>
</div>`), doc.body);

    panelEl.addEventListener('click', onPanelClick);
    panelEl.addEventListener('change', onPanelChange);
    ref('searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(true); });
    let hTimer = 0;
    ref('hq').addEventListener('input', () => { clearTimeout(hTimer); hTimer = setTimeout(() => { ui.historyShown = 100; renderHistory(); }, 200); });
    ref('file').addEventListener('change', onImportFile);
    onHost(doc, 'keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (isEditorOpen()) closeEditor();
        else if (isPanelOpen()) closePanel();
    });
}

function openPanel(tab) {
    if (!panelEl) return;
    panelEl.classList.remove('fishtts-hidden');
    switchTab(tab || ui.tab);
}
function closePanel() {
    panelEl?.classList.add('fishtts-hidden');
    previewAudio?.pause();
}
function switchTab(tab) {
    ui.tab = tab;
    panelEl.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    panelEl.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    if (tab === 'discover' && !ui.results.length && !ui.searching) runSearch(true);
    if (tab === 'mine') renderMine();
    if (tab === 'bind') renderBind();
    if (tab === 'history') renderHistory();
}

function voiceOptions(selected, { narrator = false } = {}) {
    const opts = [];
    if (narrator) opts.push([NARRATOR_SAME, '和角色音色相同']);
    opts.push(['', 'Fish 默认声音']);
    for (const v of S().voices) opts.push([v.id, (v.fav ? '♥ ' : '') + v.name]);
    if (selected && !opts.some(([id]) => id === selected)) opts.push([selected, `（已删除）${String(selected).slice(0, 6)}`]);
    return opts.map(([id, name]) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(name)}</option>`).join('');
}

function playSample(url, btn) {
    if (!url) return;
    if (!previewAudio) previewAudio = new HOST.Audio();
    const icon = btn?.querySelector('i');
    const reset = () => panelEl.querySelectorAll('[data-act="sample"] i').forEach((i) => { i.className = 'fa-solid fa-play'; });
    if (previewAudio.dataset?.url === url && !previewAudio.paused) { previewAudio.pause(); reset(); return; }
    reset();
    previewAudio.src = url;
    previewAudio.dataset.url = url;
    previewAudio.onended = reset;
    previewAudio.play().then(() => { if (icon) icon.className = 'fa-solid fa-pause'; })
        .catch((e) => toast('warning', `样音播放失败：${e.message}`));
}

function testVoice(voiceId) {
    const text = String(S().testText || DEFAULTS.testText).trim();
    playNow({ label: `试听 ${voiceName(voiceId)}`, segments: [makeSeg(text, voiceId)], record: null });
}

// ---- 发现音色

async function runSearch(reset) {
    if (ui.searching) return;
    ui.searching = true;
    if (reset) { ui.page = 1; ui.results = []; ref('results').innerHTML = '<div class="fishtts-empty">搜索中…</div>'; }
    ref('discoverInfo').textContent = '加载中…';
    try {
        const data = await fishSearch({ q: ref('q').value.trim(), page: ui.page, lang: ref('lang').value, sort: ref('sort').value });
        const items = Array.isArray(data.items) ? data.items : [];
        ui.results.push(...items);
        ui.hasMore = !!data.has_more && items.length > 0;
        ui.page += 1;
        ref('discoverInfo').textContent = `共 ${fmtCount(data.total)} 个音色，已显示 ${ui.results.length} 个`;
    } catch (e) {
        ref('discoverInfo').textContent = e.message;
        ui.hasMore = false;
    } finally {
        ui.searching = false;
    }
    renderResults();
}

function renderResults() {
    const mine = new Set(S().voices.map((v) => v.id));
    ref('results').innerHTML = ui.results.length ? ui.results.map((m, i) => {
        const cover = m.cover_image ? `${FISH_CDN}${esc(m.cover_image)}` : '';
        const sample = httpsOnly(m.samples?.[0]?.audio);
        const added = mine.has(m._id);
        return `
<div class="fishtts-card">
  ${cover ? `<img class="fishtts-cover" src="${cover}" loading="lazy" alt="">` : '<div class="fishtts-cover fishtts-cover-empty"><i class="fa-solid fa-microphone"></i></div>'}
  <div class="fishtts-card-main">
    <div class="fishtts-name" title="${esc(m.description || m.title)}">${esc(m.title)}</div>
    <div class="fishtts-dim">${esc(m.author?.nickname || '')} · 使用 ${fmtCount(m.task_count)} · ♥ ${fmtCount(m.like_count)}</div>
    <div class="fishtts-tags">${(m.tags || []).slice(0, 4).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
  </div>
  <div class="fishtts-card-actions">
    ${sample ? `<button type="button" class="menu_button" data-act="sample" data-url="${esc(sample)}" title="听官方样音"><i class="fa-solid fa-play"></i></button>` : ''}
    <button type="button" class="menu_button${added ? ' fishtts-done' : ''}" data-act="addResult" data-idx="${i}" ${added ? 'disabled' : ''}>${added ? '已添加' : '<i class="fa-solid fa-plus"></i> 添加'}</button>
    <a class="menu_button" href="https://fish.audio/m/${esc(m._id)}" target="_blank" rel="noopener" title="在 fish.audio 打开"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
  </div>
</div>`;
    }).join('') : `<div class="fishtts-empty">${ui.searching ? '搜索中…' : '没有找到音色，换个关键词或语言试试'}</div>`;
    panelEl.querySelector('[data-act="more"]').hidden = !ui.hasMore;
}

function addVoice(v) {
    const s = S();
    if (s.voices.some((x) => x.id === v.id)) return false;
    const wasEmpty = s.voices.length === 0;
    s.voices.push(v);
    if (wasEmpty && !s.defaultVoice) s.defaultVoice = v.id;
    return true;
}

// ---- 我的音色

function renderMine() {
    const s = S();
    ref('defaultVoice').innerHTML = voiceOptions(s.defaultVoice);
    ref('useDefault').checked = !!s.useDefaultForUnbound;
    if (ref('favOnly')) ref('favOnly').checked = !!s.favOnly;
    const usage = {};
    for (const v of Object.values(s.bindings)) usage[v] = (usage[v] || 0) + 1;
    const list = s.favOnly ? s.voices.filter((v) => v.fav) : s.voices;
    ref('mineList').innerHTML = list.length ? list.map((v) => `
<div class="fishtts-card">
  ${v.cover ? `<img class="fishtts-cover" src="${esc(v.cover)}" loading="lazy" alt="">` : '<div class="fishtts-cover fishtts-cover-empty"><i class="fa-solid fa-microphone"></i></div>'}
  <div class="fishtts-card-main">
    <input class="text_pole fishtts-alias" data-id="${esc(v.id)}" value="${esc(v.name)}" title="点击改名">
    <div class="fishtts-dim">${v.title && v.title !== v.name ? `${esc(v.title)} · ` : ''}${esc(v.id.slice(0, 8))}… · 绑定 ${usage[v.id] || 0} 个角色${s.defaultVoice === v.id ? ' · <b>默认</b>' : ''}</div>
  </div>
  <div class="fishtts-card-actions">
    ${v.sample ? `<button type="button" class="menu_button" data-act="sample" data-url="${esc(v.sample)}" title="听官方样音"><i class="fa-solid fa-play"></i></button>` : ''}
    <button type="button" class="menu_button" data-act="testVoice" data-id="${esc(v.id)}" title="用试听句合成（会消耗额度）"><i class="fa-solid fa-volume-high"></i></button>
    <button type="button" class="menu_button${v.fav ? ' fishtts-done' : ''}" data-act="toggleFav" data-id="${esc(v.id)}" title="${v.fav ? '取消收藏' : '收藏'}"><i class="fa-${v.fav ? 'solid' : 'regular'} fa-heart"></i></button>
    <button type="button" class="menu_button" data-act="setDefault" data-id="${esc(v.id)}" title="设为默认"><i class="fa-${s.defaultVoice === v.id ? 'solid' : 'regular'} fa-star"></i></button>
    <button type="button" class="menu_button" data-act="copyId" data-id="${esc(v.id)}" title="复制 ID"><i class="fa-regular fa-copy"></i></button>
    <button type="button" class="menu_button" data-act="delVoice" data-id="${esc(v.id)}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
  </div>
</div>`).join('') : (s.favOnly
    ? '<div class="fishtts-empty">没有收藏的音色。点卡片上的 ♥ 收藏喜欢的声音。</div>'
    : '<div class="fishtts-empty">还没有音色。去「发现音色」挑几个，或者在上面粘贴音色链接。<br>没有音色时会用 Fish 默认声音朗读。</div>');
}

async function importIds() {
    const ids = extractVoiceIds(ref('importText').value);
    if (!ids.length) { toast('warning', '没找到 32 位音色 ID。请粘贴 fish.audio 音色页链接或 ID'); return; }
    let added = 0, skipped = 0, noDetail = 0;
    for (const id of ids) {
        if (voiceById(id)) { skipped++; continue; }
        let v;
        try { v = modelToVoice(await fishModel(id)); } catch { v = sanitizeVoice({ id }); noDetail++; }
        if (addVoice(v)) added++;
    }
    save();
    ref('importText').value = '';
    renderMine();
    toast(added ? 'success' : 'info', `添加 ${added} 个${skipped ? `，${skipped} 个已存在` : ''}${noDetail ? `；${noDetail} 个读不到详情（可能是私有音色），已按 ID 添加，可自行改名` : ''}`);
}

async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let parsed;
    try { parsed = parseVoiceImport(JSON.parse(await file.text())); } catch (err) { toast('error', `不是有效的 JSON：${err.message}`); return; }
    const s = S();
    let added = 0;
    const needDetail = [];
    for (const raw of parsed.voices) {
        const v = sanitizeVoice(raw);
        if (addVoice(v)) { added++; if (!v.cover && !v.sample) needDetail.push(v); }
    }
    const bindCount = Object.keys(parsed.bindings).length;
    Object.assign(s.bindings, parsed.bindings);
    if (parsed.defaultVoice !== undefined && !s.defaultVoice) s.defaultVoice = parsed.defaultVoice;
    if (parsed.narratorVoice !== undefined && s.narratorVoice === NARRATOR_SAME) s.narratorVoice = parsed.narratorVoice;
    save();
    renderMine();
    let msg = `导入 ${added} 个音色${bindCount ? `、${bindCount} 个角色绑定` : ''}`;
    if (parsed.legacy) msg += '。这是旧版 voices.json，请到「角色绑定」重新绑定角色';
    if (parsed.skipped.length) msg += `。跳过了即时克隆声音：${parsed.skipped.join('、')}（请先在 fish.audio 创建音色后按链接添加）`;
    toast('success', msg);
    // 后台补全封面和样音，保留用户起的名字
    for (const v of needDetail) {
        try {
            const full = modelToVoice(await fishModel(v.id));
            Object.assign(v, { title: full.title, cover: full.cover, sample: full.sample, tags: full.tags, author: full.author });
        } catch { /* 私有音色读不到详情，忽略 */ }
    }
    if (needDetail.length) { save(); if (ui.tab === 'mine') renderMine(); }
}

function exportConfig() {
    const s = S();
    const data = { type: 'fish-tts-config', version: 1, exportedAt: new Date().toISOString(), voices: s.voices, bindings: s.bindings, defaultVoice: s.defaultVoice, narratorVoice: s.narratorVoice };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fish-tts-音色配置.json';
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function deleteVoice(id) {
    const s = S();
    const bound = Object.entries(s.bindings).filter(([, v]) => v === id).map(([k]) => k);
    const ok = await confirmBox(`删除音色「${voiceName(id)}」？${bound.length ? `\n同时会解除这些角色的绑定：${bound.join('、')}` : ''}`);
    if (!ok) return;
    s.voices = s.voices.filter((v) => v.id !== id);
    for (const k of bound) delete s.bindings[k];
    if (s.defaultVoice === id) s.defaultVoice = s.voices[0]?.id || '';
    if (s.narratorVoice === id) s.narratorVoice = NARRATOR_SAME;
    save();
    renderMine();
}

// ---- 角色绑定

function renderBind() {
    const s = S();
    ref('bindVoice').innerHTML = voiceOptions(s.defaultVoice);
    ref('narrator').innerHTML = voiceOptions(s.narratorVoice, { narrator: true });
    const dl = panelEl.querySelector('#fishtts-names');
    dl.innerHTML = currentNames().map((n) => `<option value="${esc(n)}"></option>`).join('');
    const entries = Object.entries(s.bindings).sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    ref('bindList').innerHTML = entries.length ? entries.map(([name, vid]) => `
<div class="fishtts-bind">
  <span class="fishtts-name" title="${esc(name)}">${esc(name)}</span>
  <select class="text_pole fishtts-bind-select" data-name="${esc(name)}">${voiceOptions(vid)}</select>
  <button type="button" class="menu_button" data-act="testVoice" data-id="${esc(vid)}" title="试听"><i class="fa-solid fa-volume-high"></i></button>
  <button type="button" class="menu_button" data-act="bindDel" data-name="${esc(name)}" title="解除绑定"><i class="fa-solid fa-link-slash"></i></button>
</div>`).join('') : '<div class="fishtts-empty">还没有绑定。未绑定的角色会按「我的音色」里的默认音色朗读。</div>';
}

// ---- 朗读历史

async function renderHistory() {
    let list = [];
    try { list = await idb.all('history'); } catch (e) {
        ref('hInfo').textContent = `无法读取朗读历史（浏览器可能禁用了本地存储）：${e.message}`;
        return;
    }
    const total = list.length;
    const q = ref('hq').value.trim().toLowerCase();
    const cur = ref('hCurrent').checked ? ctx().getCurrentChatId() : null;
    list = list.filter((r) => (!cur || r.chatId === cur) && (!q || `${r.name} ${r.text} ${r.chatLabel}`.toLowerCase().includes(q)));
    list.sort((a, b) => b.ts - a.ts);
    historyFiltered = list;
    const size = await cacheSize();
    ref('hInfo').textContent = `共 ${total} 条记录${list.length !== total ? `，筛选出 ${list.length} 条` : ''} · 音频缓存 ${fmtBytes(size)} / ${S().cacheMB} MB（只保存在这个浏览器里）`;
    const shown = list.slice(0, ui.historyShown);
    ref('historyList').innerHTML = shown.length ? shown.map((r) => `
<div class="fishtts-hitem">
  <div class="fishtts-hhead">
    <b>${esc(r.name)}</b>
    <span class="fishtts-chip">${esc((r.voices || []).join(' / '))}</span>
    ${r.tagSource === 'ai' ? '<span class="fishtts-chip fishtts-chip-ai" title="语气标签由 AI 添加">AI 标签</span>' : ''}
    ${r.tagSource === 'manual' ? '<span class="fishtts-chip fishtts-chip-edit" title="朗读稿被手动修改过">已修改</span>' : ''}
    <span class="fishtts-dim">${fmtTime(r.ts)} · ${esc(r.chatLabel || '')} · #${r.mesId}</span>
  </div>
  <div class="fishtts-htext">${highlightTags(r.text)}</div>
  <div class="fishtts-hact">
    <button type="button" class="menu_button" data-act="hPlay" data-id="${esc(r.id)}"><i class="fa-solid fa-play"></i> 重播</button>
    <button type="button" class="menu_button" data-act="hEdit" data-id="${esc(r.id)}" title="修改语气标签 / 文字后重新朗读"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>
    <button type="button" class="menu_button" data-act="hLocate" data-id="${esc(r.id)}"><i class="fa-solid fa-location-crosshairs"></i> 定位</button>
    <button type="button" class="menu_button" data-act="hExport" data-id="${esc(r.id)}" title="导出这条朗读的 MP3（缓存丢失会自动重新合成）"><i class="fa-solid fa-download"></i> 导出</button>
    <button type="button" class="menu_button" data-act="hDel" data-id="${esc(r.id)}" title="删除这条记录"><i class="fa-solid fa-trash-can"></i></button>
  </div>
</div>`).join('') : `<div class="fishtts-empty">${total ? '没有符合条件的记录' : '还没有朗读记录'}</div>`;
    panelEl.querySelector('[data-act="hMore"]').hidden = list.length <= ui.historyShown;
}

/** 转义后把 [标签] 高亮成小标签 */
function highlightTags(text) {
    return esc(text).replace(/\[([^[\]\n]{1,40})\]/g, '<span class="fishtts-tagchip">[$1]</span>');
}

// ---------------------------------------------------------------- 导出朗读历史 MP3

function downloadBlob(blob, filename) {
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

const safeFile = (s) => String(s ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'fish-tts';

/** 导出一条朗读记录的 MP3：优先用缓存，缓存被清理时自动重新合成。多段合并成一个文件。 */
async function exportRecordMp3(recId) {
    const rec = await idb.get('history', recId);
    if (!rec?.segments?.length) { toast('warning', '这条记录没有可导出的音频'); return; }
    const parts = [];
    for (let i = 0; i < rec.segments.length; i++) {
        const seg = rec.segments[i];
        setStatus(`导出 ${rec.name} ${i + 1}/${rec.segments.length}…`);
        const blob = await obtainAudio(seg);
        parts.push(new Uint8Array(await blob.arrayBuffer()));
    }
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    downloadBlob(blob, `Fish语音_${safeFile(rec.name)}_${fmtTime(rec.ts).replace(/[\/: ]/g, '-')}.mp3`);
    toast('success', `已导出「${rec.name}」的朗读 MP3`);
}

/** 批量导出当前筛选出的朗读记录（每条一个 MP3，间隔 400ms 避免浏览器拦截）。 */
async function exportHistoryMp3() {
    const list = historyFiltered.slice();
    if (!list.length) { toast('info', '当前没有可导出的朗读记录'); return; }
    setStatus(`批量导出 ${list.length} 条…`);
    for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        try {
            const parts = [];
            for (let k = 0; k < rec.segments.length; k++) {
                const blob = await obtainAudio(rec.segments[k]);
                parts.push(new Uint8Array(await blob.arrayBuffer()));
            }
            const blob = new Blob(parts, { type: 'audio/mpeg' });
            downloadBlob(blob, `Fish语音_${safeFile(rec.name)}_${String(i + 1).padStart(3, '0')}.mp3`);
            toast('success', `已导出 ${i + 1}/${list.length}`);
        } catch (e) {
            toast('error', `导出「${rec.name}」失败：${e.message}`);
        }
        await sleep(400);
    }
    setStatus(`批量导出完成`);
}

// ---- 面板事件

async function onPanelClick(e) {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id, name } = btn.dataset;
    const s = S();
    try {
        switch (act) {
            case 'close': closePanel(); break;
            case 'more': runSearch(false); break;
            case 'sample': playSample(btn.dataset.url, btn); break;
            case 'addResult': {
                const m = ui.results[Number(btn.dataset.idx)];
                if (m && addVoice(modelToVoice(m))) { save(); toast('success', `已添加「${m.title}」`); }
                renderResults();
                break;
            }
            case 'importIds': await importIds(); break;
            case 'importFile': ref('file').click(); break;
            case 'export': exportConfig(); break;
            case 'testVoice': testVoice(id); break;
            case 'setDefault': s.defaultVoice = id; save(); renderMine(); break;
            case 'toggleFav': {
                const v = voiceById(id);
                if (v) { v.fav = !v.fav; save(); renderMine(); }
                break;
            }
            case 'copyId':
                await HOST.navigator.clipboard.writeText(id).then(() => toast('success', '已复制音色 ID'), () => toast('info', id));
                break;
            case 'delVoice': await deleteVoice(id); break;
            case 'bindAdd': {
                const n = ref('bindName').value.trim();
                if (!n) { toast('warning', '请先填写角色名'); break; }
                s.bindings[n] = ref('bindVoice').value;
                ref('bindName').value = '';
                save();
                renderBind();
                break;
            }
            case 'bindCurrent': {
                const names = currentNames().filter((n) => !Object.prototype.hasOwnProperty.call(s.bindings, n));
                if (!names.length) { toast('info', '当前聊天的角色都已经绑定过了'); break; }
                for (const n of names) s.bindings[n] = s.defaultVoice;
                save();
                renderBind();
                toast('success', `已添加：${names.join('、')}，在下面的列表里选择音色`);
                break;
            }
            case 'bindDel': delete s.bindings[name]; save(); renderBind(); break;
            case 'historyClear': {
                if (!(await confirmBox('清空全部朗读历史和音频缓存？'))) break;
                await idb.clear('history');
                await idb.clear('audio');
                await idb.clear('audioMeta');
                renderHistory();
                break;
            }
            case 'hMore': ui.historyShown += 100; renderHistory(); break;
            case 'hPlay': {
                const rec = await idb.get('history', id);
                if (rec) playNow({ label: `重播 ${rec.name}`, segments: rec.segments, record: null });
                break;
            }
            case 'hEdit': {
                const rec = await idb.get('history', id);
                if (rec) openEditorForRecord(rec);
                else toast('warning', '这条记录已经被删除');
                break;
            }
            case 'hLocate': {
                const rec = await idb.get('history', id);
                if (rec) await locate(rec);
                break;
            }
            case 'hDel': await idb.del('history', id); renderHistory(); break;
            case 'hExport': await exportRecordMp3(id); break;
            case 'hExportAll': await exportHistoryMp3(); break;
            default: break;
        }
    } catch (err) {
        console.error(TAG, err);
        toast('error', err.message || String(err));
    }
}

function onPanelChange(e) {
    const t = e.target;
    const s = S();
    if (t.classList.contains('fishtts-alias')) {
        const v = voiceById(t.dataset.id);
        if (v) { v.name = t.value.trim().slice(0, 60) || v.title || v.name; t.value = v.name; save(); }
    } else if (t.classList.contains('fishtts-bind-select')) {
        s.bindings[t.dataset.name] = t.value;
        save();
    } else if (t === ref('defaultVoice')) {
        s.defaultVoice = t.value; save(); renderMine();
    } else if (t === ref('useDefault')) {
        s.useDefaultForUnbound = t.checked; save();
    } else if (t === ref('favOnly')) {
        s.favOnly = t.checked; save(); renderMine();
    } else if (t === ref('narrator')) {
        s.narratorVoice = t.value; save();
    } else if (t === ref('hCurrent')) {
        ui.historyShown = 100; renderHistory();
    } else if (t === ref('lang') || t === ref('sort')) {
        runSearch(true);
    }
}

// ---------------------------------------------------------------- 扩展设置抽屉

let settingsEl = null;

function buildSettings(container) {
    settingsEl = mount(el(`
<div id="fishtts-settings" class="fishtts-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b><i class="fa-solid fa-headphones"></i> Fish Audio 语音朗读</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="fishtts-row">
        <button type="button" class="menu_button" data-act="openPanel"><i class="fa-solid fa-list"></i> 打开语音面板</button>
        <button type="button" class="menu_button" data-act="testDefault"><i class="fa-solid fa-volume-high"></i> 测试朗读</button>
      </div>
      <label class="checkbox_label"><input type="checkbox" data-setting="enabled"> 启用</label>
      <label class="checkbox_label"><input type="checkbox" data-setting="autoRead"> 自动朗读角色的新回复</label>
      <label class="checkbox_label"><input type="checkbox" data-setting="readGreeting"> 朗读开场白</label>
      <label class="checkbox_label"><input type="checkbox" data-setting="showMesButton"> 在消息菜单里显示 <i class="fa-solid fa-headphones"></i> 朗读 和 <i class="fa-solid fa-pen-to-square"></i> 编辑按钮</label>
      <label class="checkbox_label"><input type="checkbox" data-setting="showFloat"> 显示悬浮控制条</label>
      <div class="fishtts-row"><button type="button" class="menu_button" data-act="resetFloat"><i class="fa-solid fa-location-crosshairs"></i> 找不到悬浮条？重置位置</button></div>

      <h4>API Key</h4>
      <select class="text_pole" data-setting="keyMode">
        <option value="proxy">存在酒馆密钥库，由酒馆转发（推荐）</option>
        <option value="direct">浏览器直连 Fish（Key 存在扩展设置里）</option>
      </select>
      <div class="fishtts-row">
        <input type="password" class="text_pole fishtts-grow" data-ref="keyInput" placeholder="粘贴 Fish Audio API Key" autocomplete="off">
        <button type="button" class="menu_button" data-act="saveKey">保存</button>
      </div>
      <small data-ref="keyStatus" class="fishtts-dim"></small>
      <small class="fishtts-dim">在 <a href="https://fish.audio/app/api-keys" target="_blank" rel="noopener">fish.audio → API 密钥</a> 创建。Key 只存在你自己的酒馆里，分享扩展时不会带出去。</small>

      <h4>合成</h4>
      <label>模型 <select class="text_pole" data-setting="model">${MODELS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
      <input class="text_pole" data-setting="customModel" placeholder="自定义模型 ID，例如 fish-audio/s2.1-pro">
      <label>语速 <span data-ref="speedVal"></span><input type="range" min="0.5" max="2" step="0.05" data-setting="speed"></label>

      <h4>语气标签与 AI</h4>
      <label class="checkbox_label"><input type="checkbox" data-setting="emoEnabled"> 把 [语气标签] 发给 Fish（关掉后合成前去掉所有方括号标签）</label>
      <label>朗读前编辑 <select class="text_pole" data-setting="editBeforeRead">
        <option value="off">不弹编辑器，直接朗读（需要时点消息菜单里的「编辑」按钮）</option>
        <option value="manual">点 🎧 时先打开编辑器</option>
        <option value="always">自动朗读的新回复也先打开编辑器</option>
      </select></label>
      <label class="checkbox_label"><input type="checkbox" data-setting="rememberEdits"> 编辑器默认勾选「记住这条消息的修改」</label>
      <label class="checkbox_label"><input type="checkbox" data-setting="aiAuto"> 朗读前自动让 AI 加语气标签（每条消息会多一次 AI 请求）</label>
      <label>AI 使用的模型 <select class="text_pole" data-setting="aiSource" data-ref="aiSource">${aiSourceOptions(S().aiSource)}</select></label>
      <div class="fishtts-box fishtts-aicustom" data-ref="aiCustomBox">
        <label>接口地址（OpenAI 兼容）<input class="text_pole" data-setting="aiUrl" placeholder="例如 https://api.deepseek.com/v1" autocomplete="off" spellcheck="false"></label>
        <div class="fishtts-row">
          <input type="password" class="text_pole fishtts-grow" data-ref="aiKeyInput" placeholder="这个接口的 API Key" autocomplete="off">
          <button type="button" class="menu_button" data-act="aiSaveKey">保存 Key</button>
          <button type="button" class="menu_button" data-act="aiClearKey" title="清除保存的 Key">清除</button>
        </div>
        <small class="fishtts-dim" data-ref="aiKeyStatus"></small>
        <div class="fishtts-row">
          <input class="text_pole fishtts-grow" data-setting="aiModel" list="fishtts-aimodels" placeholder="模型名，例如 deepseek-chat" autocomplete="off" spellcheck="false">
          <datalist id="fishtts-aimodels"></datalist>
          <button type="button" class="menu_button" data-act="aiModels"><i class="fa-solid fa-list"></i> <span>获取模型列表</span></button>
        </div>
        <label>请求方式 <select class="text_pole" data-setting="aiVia">
          <option value="st">经酒馆后端转发（推荐，没有跨域问题）</option>
          <option value="direct">浏览器直连（接口必须允许跨域）</option>
        </select></label>
        <small class="fishtts-dim">只用来加语气标签，和聊天用的模型互不影响，可以填一个便宜、限制少的模型。Key 存在本扩展的设置里（酒馆的 settings.json），导出音色配置时不会带出去。</small>
      </div>
      <label>标签数量 <select class="text_pole" data-setting="aiDensity">
        <option value="low">少量：只在情绪明显变化处加</option>
        <option value="normal">适中</option>
        <option value="high">丰富：语气、笑声、叹气、停顿都可以加</option>
      </select></label>
      <label class="checkbox_label"><input type="checkbox" data-setting="aiContext"> 把上一条消息的开头一起发给 AI，帮它判断情绪</label>
      <label>AI 最多回复 token 数 <input type="number" class="text_pole" min="200" max="8000" data-setting="aiMaxTokens"></label>
      <label>AI 超时（秒） <input type="number" class="text_pole" min="10" max="300" data-setting="aiTimeout"></label>
      <label>AI 提示词（系统提示）<textarea class="text_pole fishtts-prompt" rows="6" data-ref="aiPrompt"></textarea></label>
      <div class="fishtts-row">
        <button type="button" class="menu_button" data-act="aiPromptReset"><i class="fa-solid fa-rotate-left"></i> 恢复默认提示词</button>
        <button type="button" class="menu_button" data-act="aiTest"><i class="fa-solid fa-wand-magic-sparkles"></i> <span>用试听句测试 AI 加标签</span></button>
        <button type="button" class="menu_button" data-act="aiTestPlay" hidden><i class="fa-solid fa-volume-high"></i> 朗读结果</button>
      </div>
      <div class="fishtts-aitest" data-ref="aiTestOut" hidden></div>
      <small class="fishtts-dim">Fish S2 / S2.1 支持在文字里写 [happy]、[whispering]、[laughing]、[break] 这样的方括号标签，也可以写自然语言描述，如 [用颤抖的声音小声说]。标签放在句子开头效果最好。AI 只负责插入标签，改动原文的回复会被丢弃；加好的标签只存在本扩展的朗读稿里，<b>不会改聊天正文</b>，也不会进入角色的上下文。「酒馆当前连接的模型」会用你当前的预设和 API；角色卡内容太露骨时部分模型可能拒绝，建议选「自定义接口」或在「连接配置」里单独建一个便宜、限制少的配置给它用。</small>

      <h4>朗读内容</h4>
      <label>朗读模式 <select class="text_pole" data-setting="readMode">
        <option value="all">整条消息用角色音色</option>
        <option value="dialogue">只读引号里的台词</option>
        <option value="split">分角色 + 旁白（台词用角色音色，其余用旁白音色）</option>
      </select></label>
      <label class="checkbox_label"><input type="checkbox" data-setting="skipAsterisk"> 跳过 *动作描写*</label>
      <label>不朗读这些标签里的内容（逗号分隔）<input class="text_pole" data-setting="stripTags" placeholder="think, StatusBlock"></label>
      <label>单条最多朗读字数 <input type="number" class="text_pole" min="20" max="5000" data-setting="maxChars"></label>
      <label>试听句 <input class="text_pole" data-setting="testText"></label>

      <h4>历史与缓存（保存在本浏览器）</h4>
      <label>最多保留历史条数 <input type="number" class="text_pole" min="10" max="5000" data-setting="historyLimit"></label>
      <label>音频缓存上限（MB） <input type="number" class="text_pole" min="5" max="2000" data-setting="cacheMB"></label>
      <small class="fishtts-dim">v${VERSION}${IS_SHELL ? ' · 酒馆助手脚本模式' : ''}</small>
    </div>
  </div>
</div>`), container);

    const s = S();
    settingsEl.querySelectorAll('[data-setting]').forEach((input) => {
        const k = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = !!s[k];
        else input.value = s[k];
        const live = input.tagName === 'INPUT' && (input.type === 'text' || input.type === 'range' || input.type === '');
        input.addEventListener(live ? 'input' : 'change', () => onSettingChange(input));
    });
    settingsEl.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'openPanel') openPanel();
        else if (act === 'testDefault') testVoice(S().defaultVoice);
        else if (act === 'saveKey') await saveKey();
        else if (act === 'resetFloat') resetFloat();
        else if (act === 'aiPromptReset') {
            S().aiPrompt = '';
            save();
            settingsEl.querySelector('[data-ref="aiPrompt"]').value = DEFAULT_AI_PROMPT;
            toast('success', '已恢复默认提示词');
        } else if (act === 'aiTest') await testAi();
        else if (act === 'aiSaveKey') {
            const input = settingsEl.querySelector('[data-ref="aiKeyInput"]');
            const key = input.value.trim();
            if (!key) { toast('warning', '请先粘贴这个接口的 API Key'); return; }
            S().aiKey = key;
            save();
            input.value = '';
            refreshSettingsView();
            toast('success', 'Key 已保存，可以点「获取模型列表」或「用试听句测试 AI 加标签」试一下');
        } else if (act === 'aiClearKey') {
            S().aiKey = '';
            save();
            refreshSettingsView();
            toast('info', '已清除自定义接口的 Key');
        } else if (act === 'aiModels') await loadAiModels();
        else if (act === 'aiTestPlay' && aiTestResult) {
            playNow({ label: 'AI 标签试听', segments: [makeSeg(aiTestResult, S().defaultVoice)], record: null });
        }
    });

    // AI 提示词：显示内置提示词；和内置的一样时存成空，以后内置提示词升级能自动跟上
    const promptEl = settingsEl.querySelector('[data-ref="aiPrompt"]');
    promptEl.value = String(s.aiPrompt || '').trim() || DEFAULT_AI_PROMPT;
    promptEl.addEventListener('input', () => {
        const v = promptEl.value.trim();
        S().aiPrompt = !v || v === DEFAULT_AI_PROMPT.trim() ? '' : promptEl.value;
        save();
    });

    // 连接配置可能在别处新建 / 删除，展开下拉框前刷新一次
    const srcEl = settingsEl.querySelector('[data-ref="aiSource"]');
    const refreshSources = () => {
        const cur = S().aiSource;
        const html = aiSourceOptions(cur);
        if (srcEl.innerHTML !== html) { srcEl.innerHTML = html; srcEl.value = cur; }
    };
    srcEl.addEventListener('focus', refreshSources);
    srcEl.addEventListener('pointerdown', refreshSources);

    refreshSettingsView();
    refreshKeyStatus();
}

let aiTestResult = '';
async function testAi() {
    const btn = settingsEl.querySelector('[data-act="aiTest"]');
    const out = settingsEl.querySelector('[data-ref="aiTestOut"]');
    const playBtn = settingsEl.querySelector('[data-act="aiTestPlay"]');
    if (btn.disabled) return;
    const text = String(S().testText || DEFAULTS.testText).trim();
    btn.disabled = true;
    btn.querySelector('span').textContent = 'AI 处理中…';
    out.hidden = false;
    out.textContent = '正在请求 AI…';
    playBtn.hidden = true;
    aiTestResult = '';
    try {
        const res = await aiTag([text], { speaker: '角色' });
        aiTestResult = res.texts[0];
        out.innerHTML = `<b>${res.tagged ? 'AI 返回：' : 'AI 没有加标签：'}</b>${highlightTags(aiTestResult)}`;
        playBtn.hidden = false;
    } catch (e) {
        out.textContent = `失败：${e.message}`;
        if (e.aiOutput) {
            // 把 AI 的原始回复给用户看，方便判断是模型拒绝了、改了字，还是格式不对
            const d = doc.createElement('details');
            const sum = doc.createElement('summary');
            sum.textContent = 'AI 的原始回复';
            const pre = doc.createElement('div');
            pre.className = 'fishtts-airaw';
            pre.textContent = e.aiOutput.slice(0, 2000);
            d.append(sum, pre);
            out.append(d);
        }
    } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = '用试听句测试 AI 加标签';
    }
}

async function loadAiModels() {
    const btn = settingsEl.querySelector('[data-act="aiModels"]');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.querySelector('span').textContent = '读取中…';
    try {
        const ids = await fetchCustomModels();
        settingsEl.querySelector('#fishtts-aimodels').innerHTML = ids.map((id) => `<option value="${esc(id)}"></option>`).join('');
        const input = settingsEl.querySelector('[data-setting="aiModel"]');
        if (!ids.length) toast('warning', '接口返回的模型列表是空的，请手动填写模型名');
        else {
            if (!String(S().aiModel || '').trim()) { input.value = ids[0]; onSettingChange(input); }
            toast('success', `读到 ${ids.length} 个模型，点模型名输入框可以选择`);
            input.focus();
        }
    } catch (e) {
        toast('error', e.message);
    } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = '获取模型列表';
    }
}

function onSettingChange(input) {
    const s = S();
    const k = input.dataset.setting;
    if (input.type === 'checkbox') s[k] = input.checked;
    else if (input.type === 'number' || input.type === 'range') {
        const n = Number(input.value);
        if (!Number.isFinite(n)) return;
        const min = Number(input.min);
        const max = Number(input.max);
        s[k] = Math.min(max, Math.max(min, n));
        if (input.type === 'number' && String(s[k]) !== input.value) input.value = s[k];
    } else s[k] = input.value;
    save();
    if (k === 'keyMode') refreshKeyStatus();
    if (k === 'historyLimit' || k === 'cacheMB') schedulePrune();
    refreshSettingsView();
    updateFloat();
    decorateSoon();
}

function refreshSettingsView() {
    if (!settingsEl) return;
    const s = S();
    settingsEl.querySelector('[data-setting="customModel"]').hidden = s.model !== 'custom';
    settingsEl.querySelector('[data-ref="speedVal"]').textContent = `${Number(s.speed).toFixed(2)}x`;
    settingsEl.querySelector('[data-ref="aiCustomBox"]').hidden = s.aiSource !== 'custom';
    const key = String(s.aiKey || '');
    settingsEl.querySelector('[data-ref="aiKeyStatus"]').textContent = key
        ? `已保存（${maskKey(key)}）。`
        : (s.aiVia === 'direct' ? '尚未填写 Key（接口不需要 Key 时可以留空）。' : '尚未填写 Key：经酒馆转发时会用酒馆 API 设置里「自定义（OpenAI 兼容）」保存的 Key；接口不需要 Key 时也可以留空。');
}

async function refreshKeyStatus() {
    if (!settingsEl) return;
    const s = S();
    const out = settingsEl.querySelector('[data-ref="keyStatus"]');
    if (s.keyMode === 'direct') {
        out.textContent = s.directKey ? `已保存（${maskKey(s.directKey)}）。注意：直连模式下 Key 会出现在浏览器和酒馆设置文件里。` : '尚未填写 Key。';
        return;
    }
    out.textContent = '正在读取酒馆密钥库…';
    const st = await proxyKeyState();
    if (st === null) out.textContent = '读不到酒馆密钥库状态；如果保存后仍然合成失败，请改用「浏览器直连」。';
    else if (!st) out.textContent = '尚未保存 Key。';
    else out.textContent = `已保存在酒馆密钥库（${st}）。和酒馆自带 TTS 的「OpenAI Compatible」共用同一个 Key 位。`;
}

async function saveKey() {
    const input = settingsEl.querySelector('[data-ref="keyInput"]');
    const key = input.value.trim();
    if (!key) { toast('warning', '请先粘贴 API Key'); return; }
    try {
        if (S().keyMode === 'direct') { S().directKey = key; save(); } else await proxySaveKey(key);
        input.value = '';
        toast('success', 'API Key 已保存，可以点「测试朗读」试一下');
    } catch (e) {
        toast('error', e.message);
    }
    refreshKeyStatus();
}

// ---------------------------------------------------------------- 启动

function injectCss() {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('style.css', MODULE_BASE).href;
    link.id = 'fishtts-style';
    const ready = new Promise((resolve) => {
        link.addEventListener('load', () => resolve(true), { once: true });
        link.addEventListener('error', () => { console.warn(TAG, '样式表加载失败', link.href); resolve(false); }, { once: true });
        setTimeout(() => resolve(false), 8000);
    });
    mount(link, doc.head);
    return ready;
}

function addWandEntry() {
    const menu = doc.getElementById('extensionsMenu');
    if (!menu) return;
    const item = mount(el(`<div id="fishtts-wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><div class="fa-solid fa-headphones extensionsMenuExtensionButton"></div>Fish 语音面板</div>`), menu);
    item.addEventListener('click', () => openPanel());
}

function teardown() {
    try { stopAll(); } catch { /* 忽略 */ }
    previewAudio?.pause();
    while (cleanups.length) { try { cleanups.pop()(); } catch { /* 忽略 */ } }
    if (HOST.__fishTtsInstance?.owner === window) HOST.__fishTtsInstance = null;
}

async function init() {
    // 扩展和酒馆助手脚本只需要装一个；都装了就只运行先加载的那个
    // 旧实例的界面还在、所在页面也没关闭，才算还在运行；否则（比如卸载后重装、脚本被删掉）由这次加载接管
    const prev = HOST.__fishTtsInstance;
    let prevAlive = false;
    try { prevAlive = !!prev && !prev.owner?.closed && prev.ping() === true; } catch { prevAlive = false; }
    if (prevAlive) {
        console.warn(TAG, 'Fish 语音已经在运行，跳过重复加载。扩展和酒馆助手脚本只需要装一个。');
        return;
    }
    if (prev) {
        try { prev.teardown?.(); } catch { /* 旧实例所在页面已经没了 */ }
    }
    for (const id of ['fishtts-style', 'fishtts-settings', 'fishtts-panel', 'fishtts-float', 'fishtts-wand', 'fishtts-editor']) {
        doc.getElementById(id)?.remove();
    }
    HOST.__fishTtsInstance = { owner: window, version: VERSION, ping: () => !!floatEl?.isConnected, teardown };

    S();
    const cssReady = injectCss();

    const part = (name, fn) => {
        try { fn(); } catch (e) {
            console.error(TAG, `${name}初始化失败`, e);
            toast('error', `${name}初始化失败：${e?.message || e}`);
        }
    };
    part('悬浮条', buildFloat);
    part('设置', () => {
        const container = doc.getElementById('extensions_settings2') || doc.getElementById('extensions_settings');
        if (container) buildSettings(container);
        else console.warn(TAG, '没找到扩展设置区域，设置抽屉没有显示');
    });
    part('语音面板', buildPanel);
    part('朗读稿编辑器', buildEditor);
    part('魔杖菜单', addWandEntry);
    cssReady.then(() => updateFloat());

    const c = ctx();
    const ET = c.eventTypes || c.event_types || {};
    onST(ET.MESSAGE_RECEIVED, onMessageReceived);
    for (const evt of ['CHAT_CHANGED', 'MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        onST(ET[evt], decorateSoon);
    }
    onST(ET.CHAT_CHANGED, () => {
        if (isPanelOpen() && ui.tab === 'history') renderHistory();
        if (isPanelOpen() && ui.tab === 'bind') renderBind();
    });

    onHost(doc, 'click', (e) => {
        const b = e.target.closest?.('.fishtts-mes-btn, .fishtts-mes-edit');
        if (!b) return;
        e.stopPropagation();
        const mesId = Number(b.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isFinite(mesId)) return;
        if (b.classList.contains('fishtts-mes-edit')) openEditorForMessage(mesId).catch((err) => toast('error', err.message));
        else readMessage(mesId);
    });

    if (IS_SHELL) window.addEventListener('pagehide', teardown);

    decorateMessages();
    db().catch((e) => console.warn(TAG, '本地存储不可用，朗读历史和缓存将不会保存', e));
    console.log(TAG, `v${VERSION} 已加载${IS_SHELL ? '（酒馆助手脚本模式）' : ''}`);
}

if (HOST.jQuery) HOST.jQuery(() => init().catch((e) => console.error(TAG, '初始化失败', e)));
else init().catch((e) => console.error(TAG, '初始化失败', e));
