// index.js 冒烟测试：用 happy-dom + fake-indexeddb 模拟酒馆页面，假的 getContext / generateRaw / fetch。
// bun test ./dev-tests
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { IDBFactory } from 'fake-indexeddb';

GlobalRegistrator.register({
    url: 'http://127.0.0.1:8000/',
    settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true },
});

const W = window;
const until = async (cond, ms = 3000, what = '条件') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (cond()) return; } catch { /* 继续等 */ }
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`等待超时：${what}`);
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));

// ---------------------------------------------------------------- 假的酒馆环境

const toasts = [];
W.toastr = Object.fromEntries(['success', 'info', 'warning', 'error'].map((t) => [t, (msg) => toasts.push({ t, msg })]));
W.confirm = () => true;
W.indexedDB = new IDBFactory();
globalThis.indexedDB = W.indexedDB;

class FakeAudio {
    constructor() { this.paused = true; this.src = ''; this.dataset = {}; this.l = {}; }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    play() {
        this.paused = false;
        (this.l.play || []).forEach((f) => f());
        setTimeout(() => { this.paused = true; this.onended?.(); }, 5);
        return Promise.resolve();
    }
    pause() { this.paused = true; (this.l.pause || []).forEach((f) => f()); }
}
W.Audio = FakeAudio;
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:fake';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

const ttsCalls = [];
W.fetch = globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (body, type = 'application/json') => ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body, blob: async () => new Blob([body], { type }) });
    if (u.endsWith('/api/secrets/read')) return ok('{}');
    if (u.endsWith('/api/openai/custom/generate-voice')) {
        ttsCalls.push(JSON.parse(init.body));
        return ok(`mp3-${ttsCalls.length}`, 'audio/mpeg');
    }
    throw new Error(`测试里没有模拟这个请求：${u}`);
};

// 假 AI：把每段开头加上 [happy]；mode = 'bad' 时改掉原文
const ai = { mode: 'good', calls: [] };
function fakeTag(prompt) {
    const body = prompt.slice(prompt.indexOf('###1###'));
    if (ai.mode === 'bad') return body.replace(/^(###\d+###)\n(.+)$/gm, '$1\n[happy] 完全不同的话');
    return `<think>先想一想</think>\n${body.replace(/^(###\d+###)\n/gm, '$1\n[happy] ')}`;
}
async function generateRaw(...args) {
    const opts = args[0];
    ai.calls.push({ via: 'main', ...opts });
    return fakeTag(opts.prompt);
}
const profileCalls = [];
const ConnectionManagerRequestService = {
    async sendRequest(profileId, messages, maxTokens, custom) {
        profileCalls.push({ profileId, messages, maxTokens, custom });
        return { content: fakeTag(messages[1].content) };
    },
};

const listeners = {};
const eventSource = {
    on(e, f) { (listeners[e] ||= []).push(f); },
    removeListener(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
    emit(e, ...a) { (listeners[e] || []).forEach((f) => f(...a)); },
};
const eventTypes = {
    MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_id_changed', MORE_MESSAGES_LOADED: 'more_messages_loaded',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', USER_MESSAGE_RENDERED: 'user_message_rendered',
    MESSAGE_UPDATED: 'message_updated', MESSAGE_SWIPED: 'message_swiped', MESSAGE_DELETED: 'message_deleted',
};

const chat = [{ name: 'Alice', is_user: false, mes: '你好呀！*挥手* 今天天气真好。' }];
const extensionSettings = { connectionManager: { profiles: [{ id: 'p1', name: '便宜模型' }] } };
const context = {
    extensionSettings,
    saveSettingsDebounced() {},
    chat,
    characters: [{ name: 'Alice', avatar: 'alice.png' }],
    characterId: 0,
    groupId: null,
    groups: [],
    eventSource,
    eventTypes,
    getCurrentChatId: () => 'chat-1',
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' }),
    uuidv4: () => `id-${Math.random().toString(36).slice(2)}`,
    generateRaw,
    ConnectionManagerRequestService,
};
W.SillyTavern = { getContext: () => context };

function renderMes(i) {
    const node = document.createElement('div');
    node.className = 'mes';
    node.setAttribute('mesid', String(i));
    node.innerHTML = '<div class="mes_text"></div><div class="extraMesButtons"></div>';
    $('#chat').appendChild(node);
}
document.body.innerHTML = '<div id="extensions_settings2"></div><div id="extensionsMenu"></div><div id="chat"></div>';
renderMes(0);

const S = () => extensionSettings.fishAudioTts;
const editorOpen = () => !$('#fishtts-editor').classList.contains('fishtts-hidden');
const lastTts = () => ttsCalls[ttsCalls.length - 1];

beforeAll(async () => {
    await import('../repo/index.js');
    await until(() => $('#fishtts-editor') && $('.fishtts-mes-edit'), 3000, '扩展初始化');
});
afterAll(async () => { await GlobalRegistrator.unregister(); });

// ---------------------------------------------------------------- 用例

describe('v2.1.0 冒烟测试', () => {
    test('初始化：编辑器、消息按钮、设置项都在', () => {
        expect($('#fishtts-editor')).toBeTruthy();
        expect($('.fishtts-mes-btn')).toBeTruthy();
        expect($('.fishtts-mes-edit')).toBeTruthy();
        expect(S().emoEnabled).toBe(true);
        expect(S().editBeforeRead).toBe('off');
        const src = $('#fishtts-settings [data-setting="aiSource"]');
        expect([...src.options].map((o) => o.value)).toEqual(['main', 'p1']);
        expect($('#fishtts-settings [data-ref="aiPrompt"]').value).toContain('配音导演');
        expect($$('#fishtts-editor [data-act="edTag"]').length).toBeGreaterThan(40);
    });

    test('点「编辑」打开编辑器，AI 加标签，朗读时发给 Fish 的是带标签的文字', async () => {
        click($('.fishtts-mes-edit'));
        await until(editorOpen, 3000, '编辑器打开');
        const ta = $('#fishtts-editor .fishtts-ed-text');
        expect(ta.value).toBe('你好呀！ 今天天气真好。');

        click($('#fishtts-editor [data-act="edAi"]'));
        await until(() => ta.value.startsWith('[happy]'), 3000, 'AI 结果写回');
        expect(ta.value).toBe('[happy] 你好呀！ 今天天气真好。');
        expect(ai.calls).toHaveLength(1);
        expect(ai.calls[0].systemPrompt).toContain('配音导演');
        expect(ai.calls[0].prompt).toContain('说话人：Alice');
        expect(ai.calls[0].responseLength).toBe(1500);

        click($('#fishtts-editor [data-act="edPlay"]'));
        await until(() => ttsCalls.length === 1, 3000, '合成请求');
        expect(editorOpen()).toBe(false);
        expect(lastTts()).toMatchObject({
            model: 'fish-audio/s2.1-pro-free',
            input: '[happy] 你好呀！ 今天天气真好。',
            provider_endpoint: 'https://api.fish.audio/compat/v1/audio/speech',
        });
    });

    test('记住的 AI 稿：再点 🎧 自动沿用；S1 模型会转成圆括号', async () => {
        S().model = 'fish-audio/s1';
        click($('.fishtts-mes-btn'));
        await until(() => ttsCalls.length === 2, 3000, 'S1 合成请求');
        expect(lastTts().model).toBe('fish-audio/s1');
        expect(lastTts().input).toBe('(happy) 你好呀！ 今天天气真好。');
        expect(ai.calls).toHaveLength(1); // 没有再次请求 AI
        S().model = 'fish-audio/s2.1-pro-free';
    });

    test('关掉「把语气标签发给 Fish」时合成前去掉标签', async () => {
        S().emoEnabled = false;
        S().speed = 1.1; // 换语速避开音频缓存
        click($('.fishtts-mes-btn'));
        await until(() => ttsCalls.length === 3, 3000, '无标签合成请求');
        expect(lastTts().input).toBe('你好呀！ 今天天气真好。');
        S().emoEnabled = true;
        S().speed = 1;
    });

    test('自动朗读 + AI 自动加标签（带上文）', async () => {
        S().aiAuto = true;
        chat.push({ name: 'Alice', is_user: false, mes: '我有点难过。' });
        renderMes(1);
        // 和真实酒馆一样：先 MESSAGE_RECEIVED，再 CHARACTER_MESSAGE_RENDERED（这时才给消息加按钮）
        eventSource.emit('message_received', 1, 'normal');
        eventSource.emit('character_message_rendered', 1, 'normal');
        await until(() => ttsCalls.length === 4, 3000, '自动朗读合成请求');
        expect(lastTts().input).toBe('[happy] 我有点难过。');
        expect(ai.calls).toHaveLength(2);
        expect(ai.calls[1].prompt).toContain('上文');
        expect(ai.calls[1].prompt).toContain('Alice：你好呀');
        S().aiAuto = false;
    });

    test('AI 改了原文：编辑器保持原样并提示', async () => {
        await until(() => $$('.fishtts-mes-edit').length >= 2, 3000, '新消息的编辑按钮');
        ai.mode = 'bad';
        try {
            click($$('.fishtts-mes-edit')[1]);
            await until(editorOpen, 3000, '编辑器打开');
            const ta = $('#fishtts-editor .fishtts-ed-text');
            expect(ta.value).toBe('[happy] 我有点难过。'); // 载入了上次 AI 的稿子
            expect($('#fishtts-editor [data-ref="edNote"]').textContent).toContain('AI');
            click($('#fishtts-editor [data-act="edReset"]'));
            expect($('#fishtts-editor .fishtts-ed-text').value).toBe('我有点难过。');
            const n = toasts.length;
            click($('#fishtts-editor [data-act="edAi"]'));
            await until(() => toasts.length > n, 3000, '失败提示');
            expect(toasts[toasts.length - 1]).toMatchObject({ t: 'error' });
            expect(toasts[toasts.length - 1].msg).toContain('改动了原文');
            expect($('#fishtts-editor .fishtts-ed-text').value).toBe('我有点难过。');
        } finally {
            ai.mode = 'good';
        }
    });

    test('手动插入标签、只保存，下次朗读用手动稿', async () => {
        const ta = $('#fishtts-editor .fishtts-ed-text');
        ta.focus();
        ta.selectionStart = 0;
        ta.selectionEnd = 0;
        click($('#fishtts-editor [data-act="edTag"][data-tag="sighing"]'));
        expect(ta.value).toBe('[sighing]我有点难过。');
        click($('#fishtts-editor [data-act="edSave"]'));
        await until(() => !editorOpen(), 3000, '编辑器关闭');
        click($$('.fishtts-mes-btn')[1]);
        await until(() => ttsCalls.length === 5, 3000, '手动稿合成请求');
        expect(lastTts().input).toBe('[sighing]我有点难过。');
    });

    test('朗读历史：显示 AI / 已修改标记，点编辑从历史打开', async () => {
        $('#fishtts-settings [data-act="openPanel"]') && click($('#fishtts-settings [data-act="openPanel"]'));
        click($('#fishtts-panel [data-tab="history"]'));
        await until(() => $$('#fishtts-panel .fishtts-hitem').length >= 4, 3000, '历史记录');
        expect($('#fishtts-panel .fishtts-chip-ai')).toBeTruthy();
        expect($('#fishtts-panel .fishtts-chip-edit')).toBeTruthy();
        expect($('#fishtts-panel .fishtts-tagchip').textContent).toMatch(/^\[.+\]$/);
        click($('#fishtts-panel [data-act="hEdit"]'));
        await until(editorOpen, 3000, '从历史打开编辑器');
        expect($('#fishtts-editor [data-ref="edTitle"]').textContent).toContain('历史记录');
        click($('#fishtts-editor [data-act="edClose"]'));
        await until(() => !editorOpen(), 3000, '编辑器关闭');
    });

    test('「自动朗读也先打开编辑器」：新回复弹出编辑器，不直接朗读', async () => {
        S().editBeforeRead = 'always';
        const before = ttsCalls.length;
        chat.push({ name: 'Alice', is_user: false, mes: '晚安。' });
        renderMes(2);
        eventSource.emit('message_received', 2, 'normal');
        eventSource.emit('character_message_rendered', 2, 'normal');
        await until(editorOpen, 3000, '编辑器自动打开');
        expect($('#fishtts-editor [data-ref="edTitle"]').textContent).toContain('#2');
        expect(ttsCalls.length).toBe(before);
        click($('#fishtts-editor [data-act="edPlay"]'));
        await until(() => ttsCalls.length === before + 1, 3000, '确认后朗读');
        expect(lastTts().input).toBe('晚安。');
        S().editBeforeRead = 'off';
    });

    test('设置里选连接配置并测试 AI', async () => {
        const src = $('#fishtts-settings [data-setting="aiSource"]');
        src.value = 'p1';
        src.dispatchEvent(new W.Event('change', { bubbles: true }));
        expect(S().aiSource).toBe('p1');
        click($('#fishtts-settings [data-act="aiTest"]'));
        const out = $('#fishtts-settings [data-ref="aiTestOut"]');
        await until(() => out.querySelector('.fishtts-tagchip'), 3000, 'AI 测试结果');
        expect(profileCalls).toHaveLength(1);
        expect(profileCalls[0].profileId).toBe('p1');
        expect(profileCalls[0].messages[0].role).toBe('system');
        expect(profileCalls[0].custom).toMatchObject({ stream: false, extractData: true });
        expect($('#fishtts-settings [data-act="aiTestPlay"]').hidden).toBe(false);
    });

    test('提示词：改成和默认一样时存成空', () => {
        const p = $('#fishtts-settings [data-ref="aiPrompt"]');
        p.value = '只加 [happy]';
        p.dispatchEvent(new W.Event('input', { bubbles: true }));
        expect(S().aiPrompt).toBe('只加 [happy]');
        click($('#fishtts-settings [data-act="aiPromptReset"]'));
        expect(S().aiPrompt).toBe('');
        expect(p.value).toContain('配音导演');
    });
});
