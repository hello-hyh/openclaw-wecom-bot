# 🤖 OpenClaw 企业微信智能机器人插件

> ⭐ 如果觉得有用，请点击右上角的 **Star** 支持一下！

### 🔍 项目概述

**@openclaw/wecom-bot** 是一个专为 [OpenClaw](https://openclaw.ai) 打造的 <img src="docs/images/wecom-icon.png" width="16" height="16"> **企业微信智能机器人插件**。本仓库基于上游自建应用版本改造，专为 **企业微信智能机器人 (WeCom AI Bot)** 场景定制设计。

通过配置本插件，你可以直接在**企业微信群组**内添加智能机器人，通过 `@机器人` 的方式，让 AI 代理与群成员通过 JSON Webhook 与 `response_url` 机制进行现代化的被动回复交互。

> 🍴 本项目 fork 自 [Xueheng-Li/openclaw-wechat](https://github.com/Xueheng-Li/openclaw-wechat)（v0.3.6，作者：Xueheng-Li），并**重构了通信机制**以完全适配“企业微信智能机器人”。非常感谢🙏

### 智能机器人模式与对话记忆系统

本版本核心重构：

1. **通信协议变革**：从基于 XML 的自建应用收发模式，彻底切换为基于 JSON Payload + `response_url` 的**智能机器人**被动响应模式。这使得机器人无需管理员全局权限也可在群组中使用。
2. **对话记忆系统**：解决了旧版本中企业微信渠道"失忆"问题。现在使用 OpenClaw SDK 的 `recordPendingHistoryEntry` + `buildPendingHistoryContextFromMap` 实现对话历史管理，**与官方 Telegram/Discord 渠道一致**：
   - 📝 自动记录用户消息和 AI 回复到内存历史
   - 🔄 每次对话自动携带最近 20 条历史上下文
   - 🗑️ `/clear` 命令同时清除 session 和内存历史
   - 📊 `/status` 显示当前历史消息数量

### ✨ 与上游的主要区别

| 特性             | 上游 (自建应用模式 v0.1.0) | 本 Fork (智能机器人模式 v0.3.6)                 |
| ---------------- | -------------------------- | ----------------------------------------------- |
| 🎯 平台兼容      | ClawdBot                   | OpenClaw（同时保留 ClawdBot 兼容）              |
| 🛠️ 接入机制      | 自建应用 + 接收消息 API    | **智能群机器人 + 被动回调 API (更轻量)**        |
| 📨 通信协议      | XML 回调解析               | **纯 JSON Webhook + response_url 回复**         |
| 📤 发送图片/文件 | 支持 (自建应用 API)        | ❌ **(智能机器人被动回复受限，不支持发送附件)** |
| 🎙️ 语音识别      | 仅企业微信自带             | 企业微信自带 + **本地 FunASR SenseVoice STT**   |
| 🧠 对话历史      | 无                         | **SDK 级对话记忆（与官方 Telegram 一致）**      |
| 🖥️ Chat UI       | 无                         | **消息同步到 Transcript + 实时广播**            |
| 🌐 代理支持      | 无                         | **`WECOM_PROXY` 环境变量支持**                  |

---

### 📋 功能特性支持清单

| 消息类型 | 机器人接收 | 机器人发送 | 说明                                                                           |
| :------: | :--------: | :--------: | ------------------------------------------------------------------------------ |
| 📝 文本  |     ✅     |     ✅     | 支持通过 `response_url` 异步回复 markdown 文本。                               |
| 🖼️ 图片  |     ✅     |     ❌     | 💡 机器人可**接收并给 AI Vision 分析**，但回复机制受限暂不支持给群组返回图片。 |
| 🎙️ 语音  |     ✅     |     ❌     | 企业微信自带识别 + 本地 FunASR SenseVoice STT（AMR→WAV→文本）。                |
| 📹 视频  |     ✅     |     ❌     | 支持接收下载，暂不可外发。                                                     |
| 📎 文件  |     ✅     |     ❌     | 自动下载接收，可读类型(`md/txt/pdf`等)自动抛给 AI 分析。                       |

### 📦 前置要求

- [OpenClaw](https://openclaw.ai) 已安装并正常运行（`openclaw doctor` 通过）
- Node.js 环境（npm 可用）
- 拥有企业微信群聊添加机器人的权限
- 公网可访问的服务器或隧道（用于暴露接收微信群机器人回调事件的 Webhook）
- （可选）Python 3 + [FunASR](https://github.com/modelscope/FunASR) + PyTorch + FFmpeg —— 用于本地语音转文字（支持 CUDA / Apple MPS / CPU）

---

### 🛠️ 安装

#### 方式一：CLI 安装

```bash
openclaw plugin install --path /path/to/openclaw-wechat
```

#### 方式二：手动安装

1. 克隆本仓库：

```bash
git clone https://github.com/Xueheng-Li/openclaw-wechat.git
cd openclaw-wechat
npm install
```

2. 在 OpenClaw 配置文件 `~/.openclaw/openclaw.json` 中注册插件：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-wechat"]
    },
    "entries": {
      "wecom": {
        "enabled": true
      }
    }
  }
}
```

> 💡 注意：插件 ID 为 `wecom`。

---

### ⚙️ 接入配置指南

#### 第一步：在企业微信中创建智能机器人 🤖

1. 在企业微信电脑端，打开一个群聊。
2. 右键群聊或者点击右上角群设置 → **添加群机器人**。
3. 创建一个新机器人，起个名字（例如：AI 助手）并记录分配给它的一些基础参数。

#### 第二步：配置机器人的回调 URL (开发者配置) 📨

> 如果你需要机器人能够将群里 @ 它的消息转发给你的 OpenClaw 并在之后予以回复，必须开启机器人的回调机制。

1. 在机器人设置面板中找到“接收消息”或“开发者回调”配置项。
2. 填写回调 URL（例如 `https://你的域名/wecom/callback`）。
3. 企业微信页面会提供或要求你生成 **Token** 和 **EncodingAESKey**（这是后续用于 JSON 加解密验证的核心凭证）。
4. 记录下这两个重要值。此时**请先不要保存面板**，等待下一步 OpenClaw 启动并配置好路由。

#### 第三步：配置后端环境变量 🔑

在 `~/.openclaw/openclaw.json` (或系统全局环境) 中添加参数：

```json
{
  "env": {
    "vars": {
      // 智能机器人模式必填凭证，须与企微后台配置完全一致
      "WECOM_CALLBACK_TOKEN": "企微后台生成的 Token",
      "WECOM_CALLBACK_AES_KEY": "企微后台生成的 EncodingAESKey",
      "WECOM_WEBHOOK_PATH": "/wecom/callback",

      // 网络代理（如你的服务器出站受限需要科学上网）
      "WECOM_PROXY": ""
    }
  }
}
```

> 📌 **注意**：由于脱离了系统级自建应用框架，当前版机器人模式已不再严格依赖 `WECOM_CORP_ID` 或 `WECOM_AGENT_ID` 参数。

#### 第四步：配置公网访问 🔗

企业微信必须能外网访问到你的内网 Webhook，推荐使用 Cloudflare Tunnel（也可选 Nginx 端口转发 / Frp 等）。

```bash
# 启动隧道（将流量转发到 OpenClaw Gateway 本地端口 18789）
cloudflared tunnel --url http://localhost:18789 run openclaw
```

#### 第五步：验证与保存 🚀

1. 重启你的 OpenClaw Gateway 服务：

```bash
openclaw gateway restart
```

2. 验证本地 Webhook 路由：

```bash
curl https://你的域名/wecom/callback
# 预期返回 "wecom webhook ok" 或 "wecom webhook not configured"
```

3. 在企业微信刚才的开发者回调配置页面点击“**保存**”。企业微信会立刻向你的 URL 发送一次探测请求。保存成功，接入就完成了！

---

### 📝 使用指南

配置保存成功后，直接在所在的企业微信群内使用 `@机器人名字 你的问题` 即可开始对话。由于机器人采用了纯被动的 `response_url` 响应设计，无需额外获取 AccessToken，非常轻量。

#### 常用命令体系

可在发言时附带（或单一指令）下列内容：
| 命令 | 说明 |
|------|------|
| `/help` | 📋 显示机器人帮助信息 |
| `/status` | 📊 查看内存对话历史记录数 |
| `/clear` | 🗑️ 抹除已有的对话记忆上下文 |

---

### 🎙️ 本地语音转文字（stt.py）

考虑到企业微信原生的能力限制，我们外挂整合了 `stt.py`，使用 [FunASR SenseVoice-Small](https://modelscope.cn/models/iic/SenseVoiceSmall) 模型进行本地强大的离线语音识别。

**依赖安装：**

```bash
# 第一步：需要 FFmpeg 以转换 AMR 音频格式
brew install ffmpeg        # macOS
# apt install ffmpeg       # Ubuntu/Linux

# 第二步：Python 模型推理包
pip install funasr modelscope torch torchaudio torchcodec
```

> 🍎 **Apple 芯片优化**： `stt.py` 在 Apple Mac 上会自动调度 MPS 加速，而在 Linux 上默认优先使用 CUDA 推理。

独立调试：

```bash
python3 stt.py /path/to/audio.wav
```

> ⚠️ 注意如果你的 node 环境在 daemon 里找不到正确的 Python（如使用了 conda），请记得在环节变量中手动指定解释器：`"WECOM_STT_PYTHON": "/usr/local/bin/python3"`。

---

### 🔍 疑难故障排查 (FAQ)

#### ❌ 回调保存失败？

- 确验证 `Token`、`EncodingAESKey` 是否一字不差的与服务器端匹配？
- URL 栏是否支持 HTTP/HTTPS 对外访问？
- 看 OpenClaw 终端日志，有收到 `GET /wecom/callback` 的日志且返回 `200` 才算打通。

#### ❌ "@机器人" 收不到回复？

1. 查看网关日志是否有类似 `DEBUG decrypted Payload: {"msgtype":"text"...}` 的打印，确保 JSON 解密正常。
2. 本机器人由于不支持向企业微信主动推送文件、图片等消息！检查 AI 是不是生成图片去了。代码仅启用了 `markdown/text` 主动下发。

---

### 🏗️ 新版架构图

```
┌─────────────────┐       JSON Webhook       ┌──────────────────┐       ┌───────────────┐
│ 企业微信群智能机器人│ ──────(Encrypt)──────▶ │ OpenClaw Gateway │ ────▶ │  AI Agent     │
│  (@触发/主动发图)  │                         │  (port 18789)    │       │  (LLM)        │
│                 │ ◀──── response_url ──── │                  │ ◀──── │               │
└─────────────────┘       (Async Text/MD)    └──────┬───────────┘       └───────────────┘
                                                    │
                                        ┌───────────┼───────────┐
                                        ▼           ▼           ▼
                                  ┌──────────┐ ┌────────┐ ┌──────────┐
                                  │ JSON解密  │ │ STT    │ │ UI集成   │
                                  │ (AES256) │ │ FunASR │ │ Broadcast│
                                  └──────────┘ └────────┘ └──────────┘
```

## 📄 许可证

[MIT License](./LICENSE)

## 🙏 致谢

- 🍴 原始框架雏形项目：[dingxiang-me/OpenClaw-Wechat](https://github.com/dingxiang-me/OpenClaw-Wechat)，作者
  **勾勾的数字生命** ([@dingxiang-me](https://github.com/dingxiang-me))
- 🍴 企业微信自建应用项目：[Xueheng-Li/openclaw-wechat](https://github.com/Xueheng-Li/openclaw-wechat)，作者：Xueheng-Li
- 🤖 [OpenClaw](https://openclaw.ai)，由 Peter Steinberger 和 OpenClaw 社区开发
- 🎙️ [FunASR SenseVoice](https://github.com/modelscope/FunASR)，由阿里巴巴达摩院开发

欢迎提交 Issue 和 Pull Request！
