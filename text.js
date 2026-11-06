// 纯文本工具：清洗消息、切分台词/旁白、提取音色 ID、解析导入的配置。
// 不依赖 DOM 和酒馆，方便单独测试。

export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const hasWords = (s) => /[\p{L}\p{N}]/u.test(String(s || ''));

/**
 * 把一条聊天消息变成适合朗读的纯文本。
 * @param {string} raw 原始消息（可能含 HTML / Markdown / 状态栏标签）
 * @param {{stripTags?: string, skipAsterisk?: boolean}} opts
 */
export function cleanText(raw, opts = {}) {
    const { stripTags = '', skipAsterisk = true } = opts;
    let t = String(raw ?? '');

    const tags = String(stripTags).split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean);
    for (const tag of tags) {
        const n = escapeRegex(tag);
        t = t.replace(new RegExp(`<${n}\\b[^>]*>[\\s\\S]*?</${n}\\s*>`, 'gi'), '\n');
        // 没有闭合的块（例如被截断的思考过程）：从开始标签删到末尾
        t = t.replace(new RegExp(`<${n}\\b[^>]*>[\\s\\S]*$`, 'i'), '\n');
    }

    t = t.replace(/```[\s\S]*?```/g, '\n');
    t = t.replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '\n');
    t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n');
    t = t.replace(/<[^<>]*>/g, ' ');
    t = t.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
    if (skipAsterisk) t = t.replace(/\*[^*\n]+\*/g, ' ');
    t = t.replace(/[*_~`#>|]+/g, ' ');
    t = t.replace(/[ \t\u3000]+/g, ' ').replace(/ *\n\s*/g, '\n').trim();
    return hasWords(t) ? t : '';
}

const QUOTE_RE = /“([^”]*)”|"([^"\n]*)"|「([^」]*)」|『([^』]*)』/g;

/**
 * 按朗读模式切分文本。
 * all：整段用角色音色；dialogue：只读引号里的台词；split：台词用角色音色、其余用旁白音色。
 * 没有任何引号时，三种模式都整段朗读。
 * @returns {{kind: 'dialogue'|'narration', text: string}[]}
 */
export function splitText(text, mode = 'all') {
    const t = String(text || '').trim();
    if (!hasWords(t)) return [];
    if (mode !== 'dialogue' && mode !== 'split') return [{ kind: 'dialogue', text: t }];

    const parts = [];
    let last = 0;
    for (const m of t.matchAll(QUOTE_RE)) {
        if (m.index > last) parts.push({ kind: 'narration', text: t.slice(last, m.index) });
        parts.push({ kind: 'dialogue', text: m[1] ?? m[2] ?? m[3] ?? m[4] ?? '' });
        last = m.index + m[0].length;
    }
    if (last < t.length) parts.push({ kind: 'narration', text: t.slice(last) });

    const clean = parts.map((p) => ({ kind: p.kind, text: p.text.trim() })).filter((p) => hasWords(p.text));
    if (!clean.some((p) => p.kind === 'dialogue')) return [{ kind: 'dialogue', text: t }];
    if (mode === 'dialogue') {
        return [{ kind: 'dialogue', text: clean.filter((p) => p.kind === 'dialogue').map((p) => p.text).join('\n') }];
    }
    return clean;
}

/**
 * 给切分结果分配音色、合并相邻同音色片段，并限制总字数。
 * voiceId 为 '' 表示 Fish 模型默认声音；null/undefined 表示这一类不朗读。
 */
export function planSegments(parts, { charVoice, narratorVoice, maxChars = 800 } = {}) {
    const out = [];
    let budget = Math.max(20, Number(maxChars) || 800);
    for (const p of parts) {
        if (budget <= 0) break;
        const voice = p.kind === 'narration' ? narratorVoice : charVoice;
        if (voice === null || voice === undefined) continue;
        let text = p.text;
        if (text.length > budget) text = text.slice(0, budget);
        budget -= text.length;
        const prev = out[out.length - 1];
        if (prev && prev.voiceId === voice) prev.text += '\n' + text;
        else out.push({ voiceId: voice, text });
    }
    return out;
}

/** 从链接、ID 或任意文本里找出 32 位 Fish 音色 ID（去重、小写）。 */
export function extractVoiceIds(text) {
    const found = String(text || '').match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi) || [];
    return [...new Set(found.map((s) => s.toLowerCase()))];
}

/** 53 位快速哈希（不依赖 crypto.subtle，局域网 http 也能用）。 */
export function hash53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * 解析导入的 JSON，支持：
 * 1. 本扩展导出的配置 { type: 'fish-tts-config', voices, bindings, defaultVoice, narratorVoice }
 * 2. 音色数组 [{ id, name }, ...]
 * 3. 旧版服务端插件的 voices.json { "声音名": "模型ID" }（ref: 即时克隆会被跳过）
 */
export function parseVoiceImport(data) {
    const res = { voices: [], bindings: {}, defaultVoice: undefined, narratorVoice: undefined, skipped: [], legacy: false };
    const addVoice = (v) => {
        const id = String(v?.id || v?._id || '').toLowerCase();
        if (!/^[0-9a-f]{32}$/.test(id)) return false;
        res.voices.push({ ...v, id, name: String(v.name || v.title || id.slice(0, 8)) });
        return true;
    };

    if (Array.isArray(data)) {
        data.forEach(addVoice);
    } else if (data && typeof data === 'object') {
        if (Array.isArray(data.voices)) {
            data.voices.forEach(addVoice);
            if (data.bindings && typeof data.bindings === 'object') {
                for (const [k, v] of Object.entries(data.bindings)) if (typeof v === 'string') res.bindings[k] = v;
            }
            if (typeof data.defaultVoice === 'string') res.defaultVoice = data.defaultVoice;
            if (typeof data.narratorVoice === 'string') res.narratorVoice = data.narratorVoice;
        } else {
            res.legacy = true;
            for (const [name, val] of Object.entries(data)) {
                if (name.startsWith('_') || typeof val !== 'string') continue;
                const id = extractVoiceIds(val)[0];
                if (id) addVoice({ id, name });
                else res.skipped.push(name);
            }
        }
    }
    return res;
}
