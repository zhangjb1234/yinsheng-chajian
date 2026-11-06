# Fish Audio TTS for SillyTavern(酒馆语音插件)

让 SillyTavern 用 Fish Audio 的声音自动朗读角色回复。支持两种声音来源:

- **声音库模型**:角色名 → Fish Audio 声音模型 ID(声音库里随便挑,比如米哈游角色的社区模型)
- **即时克隆**:`ref:素材文件夹` 模式,参考音频 + 台词零样本合成,**不用训练、不占建模配额**

## 为什么需要一个"服务端插件"?

浏览器安全策略(CORS)禁止网页直接调用 `api.fish.audio`,所以合成请求由酒馆服务端代发。
这也是它不能做成"纯前端扩展"(git URL 装的那种)的原因 —— 所有前端扩展都绕不开这道墙。

## 安装(约 2 分钟)

1. 把本仓库克隆进酒馆的插件目录(在酒馆根目录打开终端):

   ```bash
   cd SillyTavern/plugins
   git clone https://github.com/zhangjb1234/moge.git fish-tts
   ```

2. 配置工作目录:

   ```bash
   cd fish-tts
   copy config.example.json config.json    # Windows;Linux/Mac 用 cp
   ```

   编辑 `config.json`,把 `workDir` 改成你的工作目录。

3. 在工作目录里放两个文件:

   - `voices.json`:角色映射,格式见 `voices.example.json`
   - `fish_api_key.txt`:你的 Fish Audio API Key(fish.audio → API 密钥页创建)

4. **重启酒馆**,控制台出现 `1 server plugin(s) are currently loaded` 即成功
5. SillyTavern → 扩展程序 → 酒馆助手 → 脚本 → **导入** 本仓库的 `酒馆助手脚本.json`,启用

## 使用

- 聊天时角色回复自动朗读;页面右下角「🔊 Fish 语音」面板可开关、可试听
- 想加角色/换声音:改工作目录的 `voices.json`,**实时生效不用重启**;
  角色名 → 声音名的映射在脚本开头的 `VOICE_DB` 里改

## 更新

- 酒馆配置了 `enableServerPluginsAutoUpdate` 时,每次启动自动 `git pull`
- 手动更新:`cd plugins/fish-tts && git pull`,重启酒馆

## 免费额度

插件自动使用 `model: s2.1-pro-free` 请求头(Fish Audio 官方免费开发者额度,公平使用政策)。
API Key 保存在本地 `fish_api_key.txt`,由服务端插件读取,**不会出现在网页或脚本里**。

## 注意

- `config.json` 已在 .gitignore 里,别把本机路径提交上去
- 克隆的角色音色仅供个人娱乐/同人创作,请勿商用或冒充他人
