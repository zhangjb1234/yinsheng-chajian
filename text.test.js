// text.js 单元测试：bun test ./dev-tests
import { describe, expect, test } from 'bun:test';
import {
    listEmoTags, stripEmoTags, hasSpeech, speechKey, isS1Model, toSpeechInput, formatTagInsert,
    cleanText, splitText, planSegments, buildTagRequest, parseTagResponse, planKeyOf, DEFAULT_AI_PROMPT,
    extractVoiceIds, hash53,
} from '../repo/text.js';

describe('语气标签', () => {
    test('listEmoTags / stripEmoTags', () => {
        const t = '[happy] 你好！[laughing] 哈哈 [soft tone]\n[用颤抖的声音说] 再见';
        expect(listEmoTags(t)).toEqual(['happy', 'laughing', 'soft tone', '用颤抖的声音说']);
        expect(stripEmoTags(t)).toBe('你好！ 哈哈\n再见');
    });

    test('超过 40 字的方括号不算标签', () => {
        const long = `[${'a'.repeat(41)}]`;
        expect(listEmoTags(long)).toEqual([]);
    });

    test('hasSpeech 只看去掉标签后的文字', () => {
        expect(hasSpeech('[sad] [break]')).toBe(false);
        expect(hasSpeech('[sad] 嗯')).toBe(true);
        expect(hasSpeech('……')).toBe(false);
    });

    test('speechKey 忽略标签、空格和标点', () => {
        expect(speechKey('[happy] 你好，世界！')).toBe(speechKey('你好世界'));
        expect(speechKey('[happy] 你好')).not.toBe(speechKey('您好'));
    });

    test('isS1Model', () => {
        expect(isS1Model('fish-audio/s1')).toBe(true);
        expect(isS1Model('s1-mini')).toBe(true);
        expect(isS1Model('fish-audio/s2.1-pro-free')).toBe(false);
        expect(isS1Model('fish-audio/s2-pro')).toBe(false);
    });

    test('toSpeechInput：S2 原样、S1 转圆括号、关闭时去掉标签', () => {
        const t = '[happy] 你好 [sighing] 唉';
        expect(toSpeechInput(t, { model: 'fish-audio/s2.1-pro' })).toBe(t);
        expect(toSpeechInput(t, { model: 'fish-audio/s1' })).toBe('(happy) 你好 (sighing) 唉');
        expect(toSpeechInput(t, { model: 'fish-audio/s2.1-pro', emoEnabled: false })).toBe('你好 唉');
        expect(toSpeechInput('没有标签', { model: 'fish-audio/s1' })).toBe('没有标签');
    });

    test('formatTagInsert 处理空格', () => {
        expect(formatTagInsert('happy', '', '你好')).toBe('[happy]');
        expect(formatTagInsert('happy', 'Hi', 'there')).toBe(' [happy] ');
        expect(formatTagInsert('[sad]', '你好', '')).toBe('[sad] ');
        expect(formatTagInsert('  ', '', '')).toBe('');
    });
});

describe('切分与限字', () => {
    test('cleanText 保留方括号标签、去掉 Markdown 链接', () => {
        expect(cleanText('[happy] 你好 *挥手* [链接](https://x.y)')).toBe('[happy] 你好 链接');
    });

    test('splitText split 模式：只有标签的片段并到下一段', () => {
        const parts = splitText('[sad]“我没事。”她低下头。', 'split');
        expect(parts).toEqual([
            { kind: 'dialogue', text: '[sad] 我没事。' },
            { kind: 'narration', text: '她低下头。' },
        ]);
    });

    test('splitText 末尾只有标签时并到最后一段', () => {
        const parts = splitText('他说：“走吧。”[sighing]', 'split');
        expect(parts[parts.length - 1].text).toBe('走吧。 [sighing]');
    });

    test('splitText 全是标签时返回空', () => {
        expect(splitText('[happy] [break]', 'all')).toEqual([]);
    });

    test('planSegments 限字不计标签，也不会切断标签', () => {
        const parts = [{ kind: 'dialogue', text: '[very excited and happy] 一二三四五六七八九十一二三四五六七八九十一二三四五' }];
        const out = planSegments(parts, { charVoice: 'v', narratorVoice: 'v', maxChars: 20 });
        expect(out).toHaveLength(1);
        expect(out[0].text.startsWith('[very excited and happy]')).toBe(true);
        expect(stripEmoTags(out[0].text).length).toBe(20);
    });

    test('planSegments 截断点落在标签上时保留完整标签', () => {
        const parts = [{ kind: 'dialogue', text: '一二三四五六七八九十一二三四五六七八九十[laughing]哈哈哈' }];
        const out = planSegments(parts, { charVoice: 'v', narratorVoice: 'v', maxChars: 20 });
        expect(out[0].text).not.toContain('[laugh');
        expect(listEmoTags(out[0].text).every((t) => t === 'laughing')).toBe(true);
    });
});

describe('AI 加标签', () => {
    const originals = ['你好呀，今天想聊点什么？', '我有点难过。'];

    test('buildTagRequest 带编号分隔、说话人、上文和密度', () => {
        const r = buildTagRequest(originals, { speaker: 'Alice', density: 'low', context: 'Bob：怎么了' });
        expect(r).toContain('说话人：Alice');
        expect(r).toContain('Bob：怎么了');
        expect(r).toContain('###1###\n你好呀，今天想聊点什么？');
        expect(r).toContain('###2###\n我有点难过。');
        expect(r).toContain('1～3 处');
        expect(DEFAULT_AI_PROMPT).toContain('###1###');
    });

    test('parseTagResponse 正常回复', () => {
        const out = '###1###\n[happy] 你好呀，今天想聊点什么？\n###2###\n[sad] 我有点难过。[sighing]';
        const res = parseTagResponse(out, originals);
        expect(res).toEqual({ texts: ['[happy] 你好呀，今天想聊点什么？', '[sad] 我有点难过。[sighing]'], tagged: 2, rejected: 0 });
    });

    test('parseTagResponse 去掉思考过程和代码块', () => {
        const out = '<think>想想 ###1### 乱写</think>\n```\n###1###\n[happy] 你好呀，今天想聊点什么？\n###2###\n我有点难过。\n```';
        const res = parseTagResponse(out, originals);
        expect(res.texts[0]).toBe('[happy] 你好呀，今天想聊点什么？');
        expect(res.texts[1]).toBe('我有点难过。');
        expect(res.tagged).toBe(1);
        expect(res.rejected).toBe(0);
    });

    test('parseTagResponse 改了原文的段落保持原文', () => {
        const out = '###1###\n[happy] 你好啊，今天想聊些什么？\n###2###\n[sad] 我有点难过。';
        const res = parseTagResponse(out, originals);
        expect(res.texts).toEqual([originals[0], '[sad] 我有点难过。']);
        expect(res.rejected).toBe(1);
        expect(res.tagged).toBe(1);
    });

    test('parseTagResponse 缺段落、整段拒绝', () => {
        expect(parseTagResponse('###1###\n[happy] 你好呀，今天想聊点什么？', originals).rejected).toBe(1);
        expect(parseTagResponse('抱歉，我不能处理这个请求。', originals)).toEqual({ texts: originals, tagged: 0, rejected: 2 });
    });

    test('parseTagResponse 只有一段时允许没有分隔行', () => {
        const res = parseTagResponse('[gentle] 我有点难过。', ['我有点难过。']);
        expect(res).toEqual({ texts: ['[gentle] 我有点难过。'], tagged: 1, rejected: 0 });
    });

    test('parseTagResponse 拒绝超长标签', () => {
        const res = parseTagResponse(`[${'x'.repeat(39)}] 我有点难过。`, ['我有点难过。']);
        expect(res.rejected).toBe(0);
        const res2 = parseTagResponse(`###1###\n[${'很'.repeat(41)}] 我有点难过。`, ['我有点难过。']);
        // 41 字的方括号不是标签，会被当成原文的一部分，所以文字对不上
        expect(res2.rejected).toBe(1);
    });

    test('planKeyOf 稳定且区分内容', () => {
        const a = planKeyOf([{ text: '一' }, { text: '二' }]);
        expect(planKeyOf([{ text: '一' }, { text: '二' }])).toBe(a);
        expect(planKeyOf([{ text: '一二' }])).not.toBe(a);
        expect(planKeyOf([{ text: '一' }, { text: '三' }])).not.toBe(a);
    });
});

describe('原有工具', () => {
    test('extractVoiceIds', () => {
        const id = '0123456789abcdef0123456789ABCDEF';
        expect(extractVoiceIds(`https://fish.audio/m/${id}/ 和 ${id}`)).toEqual([id.toLowerCase()]);
    });
    test('hash53 稳定', () => {
        expect(hash53('abc')).toBe(hash53('abc'));
        expect(hash53('abc')).not.toBe(hash53('abd'));
    });
});
