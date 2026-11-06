// ============================================================
// Fish Audio 语音朗读 · SillyTavern 前端扩展
// • 安装：酒馆「扩展 → 安装扩展程序」粘贴本仓库地址；也可以用酒馆助手外壳脚本加载。
// • 合成：Fish Audio OpenAI 兼容接口（/compat/v1/audio/speech），不需要服务端插件。
// • Key：默认存在酒馆密钥库，由酒馆后端转发；也可选浏览器直连。
// ============================================================
import { cleanText, splitText, planSegments, extractVoiceIds, hash53, parseVoiceImport } from './text.js';

const VERSION = '2.0.0';
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
};

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
            const req = HOST.indexedDB.open('fish-tts', 1);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('audioMeta')) d.createObjectStore('audioMeta', { keyPath: 'key' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB 被占用'));
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
    const body = { model: seg.model, input: seg.text, voice: seg.voiceId || '', response_format: 'mp3', speed: seg.speed };
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
function makeSeg(text, voiceId) {
    const model = currentModel();
    const speed = Math.min(2, Math.max(0.5, Number(S().speed) || 1));
    return { text, voiceId, model, speed, key: hash53(`${model}|${voiceId}|${speed}|${text}`) };
}

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
    if (!text) { say('info', '这条消息过滤后没有可朗读的文字'); return null; }

    const charVoice = resolveVoice(msg.name);
    const narratorVoice = s.narratorVoice === NARRATOR_SAME ? charVoice : s.narratorVoice;
    const segments = planSegments(splitText(text, s.readMode), { charVoice, narratorVoice, maxChars: s.maxChars })
        .map((p) => makeSeg(p.text, p.voiceId));
    if (!segments.length) {
        say('warning', `「${msg.name}」没有绑定音色，也没有开启「未绑定的角色用默认音色」`);
        return null;
    }

    const chat = currentChatInfo();
    return {
        label: msg.name,
        segments,
        record: {
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
            text: segments.map((x) => x.text).join('\n').slice(0, 3000),
            voices: [...new Set(segments.map((x) => voiceName(x.voiceId)))],
            segments,
        },
    };
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
    const job = buildMessageJob(Number(mesId), false);
    if (job) enqueue(job);
}

let decorateTimer = 0;
function decorateSoon() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateMessages, 120);
}
function decorateMessages() {
    const s = S();
    if (!s.enabled || !s.showMesButton) {
        doc.querySelectorAll('.fishtts-mes-btn').forEach((b) => b.remove());
        return;
    }
    doc.querySelectorAll('#chat .mes').forEach((mes) => {
        const box = mes.querySelector('.extraMesButtons');
        if (!box || box.querySelector('.fishtts-mes-btn')) return;
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
<div id="fishtts-float" class="fishtts-float">
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
    updateFloat();
}

function placeFloat(x, y) {
    const w = floatEl.offsetWidth || 48;
    const h = floatEl.offsetHeight || 48;
    const cx = Math.min(Math.max(4, x), HOST.innerWidth - w - 4);
    const cy = Math.min(Math.max(4, y), HOST.innerHeight - h - 4);
    floatEl.style.left = `${cx}px`;
    floatEl.style.top = `${cy}px`;
    floatEl.style.right = 'auto';
    floatEl.style.bottom = 'auto';
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
    if (s.floatPos) placeFloat(s.floatPos.x, s.floatPos.y);
}

// ---------------------------------------------------------------- 语音面板

const ui = { tab: 'discover', results: [], page: 1, hasMore: false, searching: false, historyShown: 100 };
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
        </div>
        <div class="fishtts-list" data-ref="mineList"></div>
      </section>

      <section data-pane="bind">
        <small class="fishtts-dim">角色名要和聊天里显示的名字完全一致。也可以给你自己的人设名绑定音色，用消息上的 <i class="fa-solid fa-headphones"></i> 手动朗读。</small>
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
    onHost(doc, 'keydown', (e) => { if (e.key === 'Escape' && isPanelOpen()) closePanel(); });
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
    for (const v of S().voices) opts.push([v.id, v.name]);
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
    const usage = {};
    for (const v of Object.values(s.bindings)) usage[v] = (usage[v] || 0) + 1;
    ref('mineList').innerHTML = s.voices.length ? s.voices.map((v) => `
<div class="fishtts-card">
  ${v.cover ? `<img class="fishtts-cover" src="${esc(v.cover)}" loading="lazy" alt="">` : '<div class="fishtts-cover fishtts-cover-empty"><i class="fa-solid fa-microphone"></i></div>'}
  <div class="fishtts-card-main">
    <input class="text_pole fishtts-alias" data-id="${esc(v.id)}" value="${esc(v.name)}" title="点击改名">
    <div class="fishtts-dim">${v.title && v.title !== v.name ? `${esc(v.title)} · ` : ''}${esc(v.id.slice(0, 8))}… · 绑定 ${usage[v.id] || 0} 个角色${s.defaultVoice === v.id ? ' · <b>默认</b>' : ''}</div>
  </div>
  <div class="fishtts-card-actions">
    ${v.sample ? `<button type="button" class="menu_button" data-act="sample" data-url="${esc(v.sample)}" title="听官方样音"><i class="fa-solid fa-play"></i></button>` : ''}
    <button type="button" class="menu_button" data-act="testVoice" data-id="${esc(v.id)}" title="用试听句合成（会消耗额度）"><i class="fa-solid fa-volume-high"></i></button>
    <button type="button" class="menu_button" data-act="setDefault" data-id="${esc(v.id)}" title="设为默认"><i class="fa-${s.defaultVoice === v.id ? 'solid' : 'regular'} fa-star"></i></button>
    <button type="button" class="menu_button" data-act="copyId" data-id="${esc(v.id)}" title="复制 ID"><i class="fa-regular fa-copy"></i></button>
    <button type="button" class="menu_button" data-act="delVoice" data-id="${esc(v.id)}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
  </div>
</div>`).join('') : '<div class="fishtts-empty">还没有音色。去「发现音色」挑几个，或者在上面粘贴音色链接。<br>没有音色时会用 Fish 默认声音朗读。</div>';
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
    const size = await cacheSize();
    ref('hInfo').textContent = `共 ${total} 条记录${list.length !== total ? `，筛选出 ${list.length} 条` : ''} · 音频缓存 ${fmtBytes(size)} / ${S().cacheMB} MB（只保存在这个浏览器里）`;
    const shown = list.slice(0, ui.historyShown);
    ref('historyList').innerHTML = shown.length ? shown.map((r) => `
<div class="fishtts-hitem">
  <div class="fishtts-hhead">
    <b>${esc(r.name)}</b>
    <span class="fishtts-chip">${esc((r.voices || []).join(' / '))}</span>
    <span class="fishtts-dim">${fmtTime(r.ts)} · ${esc(r.chatLabel || '')} · #${r.mesId}</span>
  </div>
  <div class="fishtts-htext">${esc(r.text)}</div>
  <div class="fishtts-hact">
    <button type="button" class="menu_button" data-act="hPlay" data-id="${esc(r.id)}"><i class="fa-solid fa-play"></i> 重播</button>
    <button type="button" class="menu_button" data-act="hLocate" data-id="${esc(r.id)}"><i class="fa-solid fa-location-crosshairs"></i> 定位</button>
    <button type="button" class="menu_button" data-act="hDel" data-id="${esc(r.id)}" title="删除这条记录"><i class="fa-solid fa-trash-can"></i></button>
  </div>
</div>`).join('') : `<div class="fishtts-empty">${total ? '没有符合条件的记录' : '还没有朗读记录'}</div>`;
    panelEl.querySelector('[data-act="hMore"]').hidden = list.length <= ui.historyShown;
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
            case 'hLocate': {
                const rec = await idb.get('history', id);
                if (rec) await locate(rec);
                break;
            }
            case 'hDel': await idb.del('history', id); renderHistory(); break;
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
      <label class="checkbox_label"><input type="checkbox" data-setting="showMesButton"> 在消息菜单里显示 <i class="fa-solid fa-headphones"></i> 朗读按钮</label>
      <label class="checkbox_label"><input type="checkbox" data-setting="showFloat"> 显示悬浮控制条</label>

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
    });
    refreshSettingsView();
    refreshKeyStatus();
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
    mount(link, doc.head);
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
    const prev = HOST.__fishTtsInstance;
    let prevAlive = false;
    try { prevAlive = !!prev && prev.ping() === true; } catch { prevAlive = false; }
    if (prevAlive) {
        console.warn(TAG, 'Fish 语音已经在运行，跳过重复加载。扩展和酒馆助手脚本只需要装一个。');
        return;
    }
    HOST.__fishTtsInstance = { owner: window, version: VERSION, ping: () => true };

    S();
    injectCss();

    const container = doc.getElementById('extensions_settings2') || doc.getElementById('extensions_settings');
    if (container) buildSettings(container);
    buildPanel();
    buildFloat();
    addWandEntry();

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
        const b = e.target.closest?.('.fishtts-mes-btn');
        if (!b) return;
        e.stopPropagation();
        const mesId = Number(b.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isFinite(mesId)) return;
        const job = buildMessageJob(mesId, true);
        if (job) playNow(job);
    });

    if (IS_SHELL) window.addEventListener('pagehide', teardown);

    decorateMessages();
    db().catch((e) => console.warn(TAG, '本地存储不可用，朗读历史和缓存将不会保存', e));
    console.log(TAG, `v${VERSION} 已加载${IS_SHELL ? '（酒馆助手脚本模式）' : ''}`);
}

if (HOST.jQuery) HOST.jQuery(() => init().catch((e) => console.error(TAG, '初始化失败', e)));
else init().catch((e) => console.error(TAG, '初始化失败', e));
