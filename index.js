// ============================================================
// Fish Audio TTS · SillyTavern 服务端插件
// 功能:把 Fish Audio 语音合成挂到 /api/plugins/fish_tts/tts,
//       供酒馆助手脚本(同源调用)使用。角色映射读 voices.json,
//       ref: 开头的声音走即时克隆(参考音频 + 台词,MessagePack)。
// 安装:本文件夹放入 SillyTavern/plugins/,同目录放好 config.json,重启酒馆生效。
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// ====== 读取同目录 config.json(见 config.example.json) ======
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
catch (e) { console.error('[fish-tts] 缺少或无法读取 config.json:', String(e).slice(0, 120)); }

const WORK_DIR = CONFIG.workDir || '';                       // voices.json / fish_api_key.txt / 素材文件夹 所在目录
const FREE_MODEL = CONFIG.freeModel !== undefined ? CONFIG.freeModel : 's2.1-pro-free'; // 官方免费模型;政策变化可改 null 走计费
const REF_TARGET_BYTES = 160000;                             // 参考片段挑选目标(≈25 秒 @48kbps)

const API_BASE = 'https://api.fish.audio';

const info = {
    id: 'fish_tts',
    name: 'Fish Audio TTS',
    description: 'Fish Audio 语音合成桥:voices.json 角色映射 + 即时克隆,供酒馆助手脚本调用。',
};

const readJson = (p, fallback) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

// —— 极简 MessagePack 编码器(只实现本插件用到的类型:null/bool/数值/字符串/Buffer/数组/对象) ——
function mpEnc(v, out) {
    if (v === null || v === undefined) { out.push(Buffer.from([0xc0])); return; }
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
        const b = Buffer.from(v);
        const h = Buffer.alloc(5);
        if (b.length < 256) { h[0] = 0xc4; h.writeUInt8(b.length, 1); out.push(h.subarray(0, 2), b); }
        else if (b.length < 65536) { h[0] = 0xc5; h.writeUInt16BE(b.length, 1); out.push(h.subarray(0, 3), b); }
        else { h[0] = 0xc6; h.writeUInt32BE(b.length, 1); out.push(h, b); }
        return;
    }
    if (typeof v === 'string') {
        const b = Buffer.from(v, 'utf8');
        const h = Buffer.alloc(5);
        if (b.length < 32) { h[0] = 0xa0 | b.length; out.push(h.subarray(0, 1), b); }
        else if (b.length < 256) { h[0] = 0xd9; h.writeUInt8(b.length, 1); out.push(h.subarray(0, 2), b); }
        else if (b.length < 65536) { h[0] = 0xda; h.writeUInt16BE(b.length, 1); out.push(h.subarray(0, 3), b); }
        else { h[0] = 0xdb; h.writeUInt32BE(b.length, 1); out.push(h, b); }
        return;
    }
    if (Array.isArray(v)) {
        const h = Buffer.alloc(3);
        if (v.length < 16) { h[0] = 0x90 | v.length; out.push(h.subarray(0, 1)); }
        else { h[0] = 0xdc; h.writeUInt16BE(v.length, 1); out.push(h.subarray(0, 3)); }
        for (const x of v) mpEnc(x, out);
        return;
    }
    if (typeof v === 'object') {
        const entries = Object.entries(v);
        const h = Buffer.alloc(3);
        if (entries.length < 16) { h[0] = 0x80 | entries.length; out.push(h.subarray(0, 1)); }
        else { h[0] = 0xde; h.writeUInt16BE(entries.length, 1); out.push(h.subarray(0, 3)); }
        for (const [k, x] of entries) { mpEnc(String(k), out); mpEnc(x, out); }
        return;
    }
    if (typeof v === 'boolean') { out.push(Buffer.from([v ? 0xc3 : 0xc2])); return; }
    if (typeof v === 'number' && Number.isFinite(v)) {
        const h = Buffer.alloc(9); h[0] = 0xcb; h.writeDoubleBE(v, 1); out.push(h); return;
    }
    throw new Error('msgpack 不支持的类型: ' + typeof v);
}
const mpPack = (obj) => { const out = []; mpEnc(obj, out); return Buffer.concat(out); };

const init = (router) => {
    if (!WORK_DIR) console.error('[fish-tts] 未配置 workDir:请在插件目录创建 config.json(参考 config.example.json)');

    // 声音列表
    router.get('/voices', (req, res) => {
        const voices = readJson(path.join(WORK_DIR, 'voices.json'), {});
        res.json({
            object: 'list',
            data: Object.keys(voices).filter(k => !k.startsWith('_')).map(v => ({ id: v, object: 'model' })),
        });
    });

    // 合成:POST {voice, text} → audio/mpeg
    router.post('/tts', express.json({ limit: '1mb' }), async (req, res) => {
        try {
            if (!WORK_DIR) return res.status(500).json({ error: '插件未配置 workDir,请创建 config.json(见 config.example.json)' });
            const body = req.body || {};
            const voice = String(body.voice || '').trim();
            const text = String(body.text || '').trim();
            if (!voice || !text) return res.status(400).json({ error: '缺少 voice 或 text' });

            const voices = readJson(path.join(WORK_DIR, 'voices.json'), {});
            const rid = voices[voice];
            if (!rid) return res.status(400).json({
                error: `未知声音「${voice}」`,
                available: Object.keys(voices).filter(k => !k.startsWith('_')),
            });

            let key = '';
            try { key = (fs.readFileSync(path.join(WORK_DIR, 'fish_api_key.txt'), 'utf8') || '').trim(); } catch { }
            if (!key) return res.status(500).json({ error: 'fish_api_key.txt 不存在或为空' });

            let payload, contentType;
            if (String(rid).startsWith('ref:')) {
                // 即时克隆:挑 3 条最接近目标时长的参考音频 + 台词,打包 MessagePack
                const dir = path.join(WORK_DIR, String(rid).slice(4));
                const meta = readJson(path.join(dir, '参考文本.json'), null);
                if (!meta) return res.status(500).json({ error: `${dir} 缺少 参考文本.json` });
                const clips = fs.readdirSync(dir)
                    .filter(f => /\.(mp3|wav|flac)$/i.test(f) && meta[f])
                    .map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }))
                    .sort((a, b) => Math.abs(a.size - REF_TARGET_BYTES) - Math.abs(b.size - REF_TARGET_BYTES))
                    .slice(0, 3)
                    .map(({ f }) => ({ audio: fs.readFileSync(path.join(dir, f)), text: meta[f] }));
                if (!clips.length) return res.status(500).json({ error: '没有可用的参考音频+台词配对' });
                payload = mpPack({ text, references: clips, format: 'mp3' });
                contentType = 'application/msgpack';
            } else {
                payload = JSON.stringify({ text, reference_id: rid, format: 'mp3' });
                contentType = 'application/json';
            }

            const headers = { 'Content-Type': contentType, Authorization: 'Bearer ' + key };
            if (FREE_MODEL) headers.model = FREE_MODEL;

            let resp = null;
            for (let i = 0; i < 3; i++) {
                resp = await fetch(`${API_BASE}/v1/tts`, { method: 'POST', headers, body: payload });
                if (resp.status !== 429) break;
                const wait = parseInt(resp.headers.get('retry-after') || '5', 10) || 5;
                console.log(`[fish-tts] 限流,${wait}s 后重试`);
                await new Promise(r => setTimeout(r, wait * 1000));
            }
            if (!resp.ok) {
                const detail = (await resp.text()).slice(0, 300);
                return res.status(502).json({ error: `Fish API HTTP ${resp.status}: ${detail}` });
            }
            const audio = Buffer.from(await resp.arrayBuffer());
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', String(audio.length));
            res.end(audio);
            console.log(`[fish-tts] ${voice}: ${text.slice(0, 20)}… -> ${audio.length} bytes`);
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
        }
    });
};

const exit = async () => { };

module.exports = { info, init, exit };
