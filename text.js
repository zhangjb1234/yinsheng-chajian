// 纯文本工具：清洗消息、切分台词/旁白、语气标签、AI 加标签的提示词与结果校验、提取音色 ID、解析导入的配置。
// 不依赖 DOM 和酒馆，方便单独测试。

export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const hasWords = (s) => /[\p{L}\p{N}]/u.test(String(s || ''));

// ---------------------------------------------------------------- 语气标签
// Fish S2 / S2.1 系列用方括号写语气：[happy] [whispering] [sighing]，也可以写自然语言 [softly, teasing]。
// S1 用圆括号 (happy)。本扩展内部统一写方括号，合成 S1 时再转换。

const TAG_SRC = '\\[([^\\[\\]\\n]{1,40})\\]';
const tagRe = () => new RegExp(TAG_SRC, 'g');

/** 文本里出现的语气标签（不含方括号）。 */
export function listEmoTags(text) {
    return [...String(text ?? '').matchAll(tagRe())].map((m) => m[1].trim()).filter(Boolean);
}

/** 去掉所有 [语气标签]，返回纯朗读文字。 */
export function stripEmoTags(text) {
    return String(text ?? '')
        .replace(tagRe(), ' ')
        .replace(/[ \t\u3000]{2,}/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
}

/** 去掉标签后还有没有可以读出来的文字。 */
export const hasSpeech = (text) => hasWords(stripEmoTags(text));

/** 只保留文字和数字，用来判断 AI 有没有改动原文。 */
export function speechKey(text) {
    return stripEmoTags(text).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

export function isS1Model(model) {
    return /(^|[/_-])s1($|[^.\d])/i.test(String(model || ''));
}

/**
 * 把编辑稿变成真正发给 Fish 的文字。
 * @param {string} text 编辑稿（方括号标签）
 * @param {{model?: string, emoEnabled?: boolean}} opts emoEnabled=false 时去掉全部标签
 */
export function toSpeechInput(text, { model = '', emoEnabled = true } = {}) {
    const t = String(text ?? '');
    if (!emoEnabled) return stripEmoTags(t);
    if (isS1Model(model)) return t.replace(tagRe(), '($1)');
    return t;
}

/** 在光标处插入标签时用：保证标签和前后文字之间有空格（中文前后不加）。 */
export function formatTagInsert(tag, before = '', after = '') {
    const body = String(tag || '').trim().replace(/^\[|\]$/g, '').trim();
    if (!body) return '';
    const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
    const b = String(before).slice(-1);
    const a = String(after).slice(0, 1);
    const left = b && !/\s/.test(b) && !cjk.test(b) ? ' ' : '';
    const right = a && !/\s/.test(a) && !cjk.test(a) ? ' ' : (a ? '' : ' ');
    return `${left}[${body}]${right}`;
}

// ---------------------------------------------------------------- 清洗与切分

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
 * 只有语气标签、没有文字的片段（例如 [sad]“……” 里的 [sad]）会并到后面那一段的开头。
 * @returns {{kind: 'dialogue'|'narration', text: string}[]}
 */
export function splitText(text, mode = 'all') {
    const t = String(text || '').trim();
    if (!hasSpeech(t)) return [];
    if (mode !== 'dialogue' && mode !== 'split') return [{ kind: 'dialogue', text: t }];

    const parts = [];
    let last = 0;
    for (const m of t.matchAll(QUOTE_RE)) {
        if (m.index > last) parts.push({ kind: 'narration', text: t.slice(last, m.index) });
        parts.push({ kind: 'dialogue', text: m[1] ?? m[2] ?? m[3] ?? m[4] ?? '' });
        last = m.index + m[0].length;
    }
    if (last < t.length) parts.push({ kind: 'narration', text: t.slice(last) });

    const clean = [];
    let carry = [];
    for (const p of parts) {
        const txt = p.text.trim();
        if (!hasSpeech(txt)) {
            carry.push(...listEmoTags(txt).map((x) => `[${x}]`));
            continue;
        }
        clean.push({ kind: p.kind, text: carry.length ? `${carry.join('')} ${txt}` : txt });
        carry = [];
    }
    if (carry.length && clean.length) clean[clean.length - 1].text += ` ${carry.join('')}`;

    if (!clean.some((p) => p.kind === 'dialogue')) return [{ kind: 'dialogue', text: t }];
    if (mode === 'dialogue') {
        return [{ kind: 'dialogue', text: clean.filter((p) => p.kind === 'dialogue').map((p) => p.text).join('\n') }];
    }
    return clean;
}

/**
 * 给切分结果分配音色、合并相邻同音色片段，并限制总字数（标签不算字数）。
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
        const len = speechLen(text);
        if (len > budget) {
            text = cutSpeech(text, budget);
            budget = 0;
        } else {
            budget -= len;
        }
        if (!hasSpeech(text)) continue;
        const prev = out[out.length - 1];
        if (prev && prev.voiceId === voice) prev.text += '\n' + text;
        else out.push({ voiceId: voice, text });
    }
    return out;
}

/** 朗读字数：不算标签和空白。 */
const speechLen = (text) => stripEmoTags(text).replace(/\s/g, '').length;

/** 按朗读字数截断（标签和空白不计数），不会把标签切成半个。 */
function cutSpeech(text, limit) {
    let count = 0;
    let out = '';
    const re = new RegExp(TAG_SRC, 'y');
    let i = 0;
    while (i < text.length && count < limit) {
        re.lastIndex = i;
        const m = re.exec(text);
        if (m) { out += m[0]; i += m[0].length; continue; }
        out += text[i];
        if (!/\s/.test(text[i])) count++;
        i++;
    }
    return out.trim();
}

// ---------------------------------------------------------------- AI 加语气标签

export const DEFAULT_AI_PROMPT = `你是有声书配音导演，负责给 Fish Audio S2 语音合成稿加「语气标签」，让朗读更有感情。

规则：
1. 只能插入英文方括号标签，例如 [happy] [sad] [angry] [excited] [nervous] [embarrassed] [calm] [whispering] [soft tone] [shouting] [laughing] [chuckling] [sighing] [sobbing] [gasping] [panting] [break] [long-break] [emphasis]。也可以用很短的英文描述，例如 [teasing] [trembling voice] [sleepy and soft]。
2. 绝对不要改动、删除、增加、翻译或调换原文的任何文字和标点。原文里已经有的 [标签] 原样保留。
3. 情绪标签放在它影响的那句话开头；声音效果（笑、叹气、喘气）和停顿放在发生的位置。
4. 每句话最多 2 个标签，标签要符合上下文和说话人的性格，不要每句都加。
5. 按原样输出每一段，保留 ###1### 这样的分隔行和编号，不要输出任何解释、引号或代码块。`;

const DENSITY_HINT = {
    low: '标签要少：整段只在情绪最明显的 1～3 处加。',
    normal: '标签适量：情绪变化、语气转折和明显的声音动作处加。',
    high: '标签可以多一些：大部分句子都可以有情绪或语气标签，但每句不超过 2 个。',
};

/**
 * 生成发给 AI 的用户消息。
 * @param {string[]} texts 每一段朗读稿
 * @param {{speaker?: string, density?: 'low'|'normal'|'high', context?: string}} opts
 */
export function buildTagRequest(texts, { speaker = '', density = 'normal', context = '' } = {}) {
    const lines = [];
    if (speaker) lines.push(`说话人：${speaker}`);
    if (context) lines.push(`上文（只用来理解情绪，不要输出）：\n${String(context).slice(0, 600)}`);
    lines.push(DENSITY_HINT[density] || DENSITY_HINT.normal);
    lines.push(`下面共 ${texts.length} 段，请逐段加标签后按同样格式输出：`);
    texts.forEach((t, i) => { lines.push(`###${i + 1}###`); lines.push(String(t ?? '')); });
    return lines.join('\n');
}

/**
 * 解析 AI 的回复，逐段校验：去掉标签后的文字必须和原文一致，否则该段保持原文。
 * @returns {{texts: string[], tagged: number, rejected: number}}
 */
export function parseTagResponse(output, originals) {
    let out = String(output ?? '');
    out = out.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    // 有的接口只留下结尾的 </think>：去掉它之前的思考过程
    const closeAt = out.search(/<\/(think|thinking|reasoning)\s*>(?![\s\S]*<\/(think|thinking|reasoning)\s*>)/i);
    if (closeAt >= 0) out = out.slice(closeAt).replace(/^<\/[a-z]+\s*>/i, '');
    out = out.replace(/^\s*```[a-z]*\s*$/gim, '');
    const map = new Map();
    // 允许 AI 给分隔行加粗或引用：**###1###**、> ###1###
    const re = /^[ \t>*_]*#{3}[ \t]*(\d+)[ \t]*#{3}[ \t*_]*$/gm;
    const marks = [...out.matchAll(re)];
    marks.forEach((m, i) => {
        const start = m.index + m[0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : out.length;
        const n = Number(m[1]);
        if (!map.has(n)) map.set(n, out.slice(start, end).trim());
    });
    // 只有一段、AI 又没写分隔行时，直接拿整段回复来校验
    if (!marks.length && originals.length === 1) map.set(1, out.trim());

    let tagged = 0;
    let rejected = 0;
    const texts = originals.map((orig, i) => {
        const cand = map.get(i + 1);
        const fixed = cand ? matchOriginal(cand, orig) : null;
        if (fixed === null) { rejected++; return orig; }
        if (listEmoTags(fixed).some((t) => t.length > 40)) { rejected++; return orig; }
        if (listEmoTags(fixed).length > listEmoTags(orig).length) tagged++;
        return fixed;
    });
    return { texts, tagged, rejected };
}

/**
 * 校验一段 AI 回复：去掉标签后必须和原文一致。
 * AI 常在前后多写一行「好的，以下是加好标签的文本：」之类的话，所以也试着去掉开头 / 结尾的整行再比。
 * 只删整行、不改行内文字，校验没有放宽。
 * @returns {string|null} 通过校验的文字；对不上时为 null
 */
function matchOriginal(cand, orig) {
    const key = speechKey(orig);
    const fixed = cand.replace(/[ \t]+\n/g, '\n').trim();
    if (speechKey(fixed) === key) return fixed;
    const lines = fixed.split('\n');
    if (lines.length < 2 || lines.length > 60) return null;
    for (let a = 0; a < lines.length; a++) {
        for (let b = lines.length; b > a; b--) {
            if (a === 0 && b === lines.length) continue;
            const t = lines.slice(a, b).join('\n').trim();
            if (t && speechKey(t) === key) return t;
        }
    }
    return null;
}

// ---------------------------------------------------------------- 自定义 AI 接口（OpenAI 兼容）

/**
 * 整理用户填的接口地址：去掉结尾的 / 和 /chat/completions、/models。
 * 只接受 http(s)，否则返回 ''。
 */
export function normalizeApiBase(url) {
    let v = String(url ?? '').trim().replace(/\/+$/, '');
    v = v.replace(/\/(chat\/completions|completions|models)$/i, '').replace(/\/+$/, '');
    return /^https?:\/\/[^\s/]+/i.test(v) ? v : '';
}

/**
 * 从 OpenAI 兼容的 /chat/completions 回复里取出正文。
 * @returns {{text: string, reasoning: string, finish: string}}
 */
export function readChatCompletion(data) {
    const choice = data?.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    let text = msg.content ?? choice.text ?? data?.content ?? '';
    if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
    const reasoning = String(msg.reasoning_content ?? msg.reasoning ?? '');
    return { text: String(text ?? ''), reasoning, finish: String(choice.finish_reason ?? '') };
}

/** 从 /models 回复里取模型 ID 列表（兼容 {data:[{id}]}、{models:[{name}]}、字符串数组）。 */
export function readModelList(data) {
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const ids = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? '')).map((s) => String(s).trim()).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- 其它

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

/** 一条消息「原始朗读稿」的指纹：用来记住这条消息的 AI 标签 / 手动修改。 */
export function planKeyOf(segments) {
    return hash53(`plan|${(segments || []).map((s) => String(s?.text ?? '')).join('\u0001')}`);
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
