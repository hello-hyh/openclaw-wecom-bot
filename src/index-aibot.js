import crypto from "node:crypto";
import {
  normalizePluginHttpPath,
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntry,
  clearHistoryEntriesIfEnabled,
} from "clawdbot/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  unlink,
  mkdir,
  appendFile,
} from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const PLUGIN_VERSION = _require("../package.json").version;

// --- Proxy support for WeCom API calls ---
import { ProxyAgent as _UndiciProxyAgent } from "undici";

const WECOM_PROXY_URL =
  process.env.WECOM_PROXY || process.env.HTTPS_PROXY || "";
let _wecomProxyDispatcher = null;
if (WECOM_PROXY_URL) {
  _wecomProxyDispatcher = new _UndiciProxyAgent(WECOM_PROXY_URL);
}

function wecomFetch(url, opts = {}) {
  if (
    _wecomProxyDispatcher &&
    typeof url === "string" &&
    url.includes("qyapi.weixin.qq.com")
  ) {
    return fetch(url, { ...opts, dispatcher: _wecomProxyDispatcher });
  }
  return fetch(url, opts);
}
// --- End proxy support ---

const execFileAsync = promisify(execFile);

// 请求体大小限制 (1MB)
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

function readRequestBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`Request body too large (limit: ${maxSize} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return sha1(arr.join(""));
}

function decodeAesKey(aesKey) {
  const base64 = aesKey.endsWith("=") ? aesKey : `${aesKey}=`;
  return Buffer.from(base64, "base64");
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

function decryptWecom({
  aesKey,
  cipherTextBase64,
  cipherBuffer = null,
  bufferMode = false,
}) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);

  const targetBuffer = cipherBuffer || Buffer.from(cipherTextBase64, "base64");

  const plain = Buffer.concat([
    decipher.update(targetBuffer),
    decipher.final(),
  ]);
  const unpadded = pkcs7Unpad(plain);

  if (bufferMode) {
    // 官方文档声明：文件下载数据是纯净的 AES-256-CBC 密文，PKCS#7 填充
    // 并没有包装 16 字节 random、4 字节 msg_len 和 receiveid 这层消息专用的结构
    return unpadded;
  }

  const msgLen = unpadded.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  const msg = unpadded.subarray(msgStart, msgEnd).toString("utf8");
  const receiveId = unpadded.subarray(msgEnd).toString("utf8");
  return { msg, receiveId };
}

function pkcs7Pad(buf) {
  const blockSize = 32;
  const padArgs = blockSize - (buf.length % blockSize);
  const padBuf = Buffer.alloc(padArgs);
  padBuf.fill(padArgs);
  return Buffer.concat([buf, padBuf]);
}

function generateRandomString(length) {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// 智能机器人加密时 receiveid 传空字符串
function encryptWecom({ aesKey, text, receiveId = "" }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);

  const randomStr = Buffer.from(generateRandomString(16), "utf8");
  const msgBuf = Buffer.from(text, "utf8");
  const receiveIdBuf = Buffer.from(receiveId, "utf8");

  const msgLenBuf = Buffer.alloc(4);
  msgLenBuf.writeUInt32BE(msgBuf.length, 0);

  const plainBuf = Buffer.concat([randomStr, msgLenBuf, msgBuf, receiveIdBuf]);
  const paddedBuf = pkcs7Pad(plainBuf);

  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);

  const encrypted = Buffer.concat([cipher.update(paddedBuf), cipher.final()]);

  return encrypted.toString("base64");
}

function requireEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v;
}

// 简单的限流器，防止触发企业微信 API 限流
class RateLimiter {
  constructor({ maxConcurrent = 3, minInterval = 200 }) {
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minInterval;
    this.running = 0;
    this.queue = [];
    this.lastExecution = 0;
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const waitTime = Math.max(0, this.lastExecution + this.minInterval - now);

    if (waitTime > 0) {
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }

    this.running++;
    this.lastExecution = Date.now();

    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.running--;
      this.processQueue();
    }
  }
}

// 发送主动回复限流器（最多3并发，100ms间隔）
const apiLimiter = new RateLimiter({ maxConcurrent: 3, minInterval: 100 });

// 通过 response_url 主动回复 Markdown 消息
// 注意：必须使用原始 fetch，否则会返回 60140 错误
async function sendWecomMarkdownMessage({
  responseUrl,
  markdownContent,
  logger,
}) {
  return apiLimiter.execute(async () => {
    const body = {
      msgtype: "markdown",
      markdown: {
        content: markdownContent,
      },
    };

    const sendRes = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(
        `WeCom Markdown message send via response_url failed: ${JSON.stringify(sendJson)}`,
      );
    }
    return sendJson;
  });
}

// 从 URL 下载媒体文件
async function fetchMediaFromUrl(url) {
  // 智能机器人的媒体文件可能在 cos 上，或者也可以处理本地的 URL
  if (url.startsWith("/") || url.startsWith("~")) {
    const filePath = url.startsWith("~") ? url.replace("~", homedir()) : url;
    const buffer = await readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const mimeMap = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      mp4: "video/mp4",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      amr: "audio/amr",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      md: "text/markdown",
      txt: "text/plain",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";
    return { buffer, contentType };
  }
  const res = await fetch(url);

  const contentType =
    res.headers.get("content-type") || "application/octet-stream";
  const contentDisposition = res.headers.get("content-disposition") || "";

  if (!res.ok) {
    throw new Error(
      `Failed to fetch media from URL: ${res.status} ${res.statusText}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  return {
    buffer,
    contentType,
    contentDisposition,
    isWecomCorpus: true, // 企微环境默认推测需要解密
  };
}

const WecomAibotPlugin = {
  id: "wecom", // 保持相同 ID 以便替换现有配置
  meta: {
    id: "wecom",
    label: "WeCom Aibot",
    selectionLabel: "WeCom (企业微信智能机器人)",
    docsPath: "/channels/wecom",
    blurb:
      "Enterprise WeChat AI Bot integration via JSON callback and response_url.",
    aliases: ["wework", "qiwei", "wxwork", "wecom-aibot"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: {
      inbound: true,
      outbound: false, // 智能机器人通过 response_url 主动回复暂时不包含媒体上传功能
    },
    markdown: true,
  },
  messaging: {
    targetResolver: {
      hint: "请输入正确的企业微信 UserId 或 wecom:UserId",
      looksLikeId: (raw, normalized) => {
        if (!raw) return false;
        if (/^wecom:/i.test(raw)) return true;
        if (/^[a-zA-Z0-9_.-]+$/.test(raw)) return true;
        return false;
      },
    },
  },
  config: {
    listAccountIds: (cfg) => {
      const accounts = cfg.channels?.wecom?.accounts;
      if (accounts && Object.keys(accounts).length > 0)
        return Object.keys(accounts);
      if (cfg.channels?.wecom?.callbackToken) return ["default"];
      return [];
    },
    resolveAccount: (cfg, accountId) => {
      const id = accountId ?? "default";
      const account = cfg.channels?.wecom?.accounts?.[id];
      if (account) return account;
      // 兼容扁平配置：直接返回顶层 wecom 配置
      const wc = cfg.channels?.wecom;
      if (wc?.callbackToken)
        return {
          accountId: id,
          callbackToken: wc.callbackToken,
          callbackAesKey: wc.callbackAesKey,
        };
      return { accountId: id };
    },
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed)
        return {
          ok: false,
          error: new Error("WeCom requires --to <UserId>"),
        };
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text }) => {
      // 警告：主动发起到指定用户的非应答消息在智能机器人中需要用到不同的 API 或者特定的应用逻辑。
      // 这个通道主要为能够利用 responseUrl 而设计，所以只保留接口以保证兼容。
      return {
        ok: false,
        error: new Error(
          "WeCom AI bot channel acts via inbound request responses (response_url). Use direct response_url in the integration.",
        ),
      };
    },
    sendMedia: async ({ to, text, mediaUrl }) => {
      return {
        ok: false,
        error: new Error("Not supported via generic outbound in Aibot mode"),
      };
    },
  },
  inbound: {
    deliverReply: async ({ to, text, accountId, mediaUrl, mediaType }) => {
      // 同样返回不支持，因为发送必须通过 response_url，而这些 API 一般是直接使用的
      return { ok: false, error: new Error("Use response_url to reply") };
    },
  },
};

// 存储 runtime 引用
let gatewayRuntime = null;

// 存储 gateway broadcast 上下文，用于向 Chat UI 广播消息
let gatewayBroadcastCtx = null;

// 在内存中维护最近的 messages -> response_url 的映射
const sessionResponseUrls = new Map(); // key: sessionId, value: response_url

// 写入消息到 session transcript 文件
async function writeToTranscript({ sessionKey, role, text, logger }) {
  try {
    const stateDir =
      process.env.CLAWDBOT_STATE_DIR || join(homedir(), ".clawdbot");
    const sessionsDir = join(stateDir, "agents", "main", "sessions");
    const sessionsJsonPath = join(sessionsDir, "sessions.json");

    if (!existsSync(sessionsJsonPath)) {
      logger?.warn?.("wecom: sessions.json not found");
      return;
    }

    const { readFileSync } = await import("node:fs");
    const sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf8"));
    const sessionEntry =
      sessionsData[sessionKey] || sessionsData[sessionKey.toLowerCase()];

    if (!sessionEntry?.sessionId) {
      logger?.warn?.(`wecom: session entry not found for ${sessionKey}`);
      return;
    }

    const transcriptPath =
      sessionEntry.sessionFile ||
      join(sessionsDir, `${sessionEntry.sessionId}.jsonl`);

    const now = Date.now();
    const messageId = randomUUID().slice(0, 8);

    const transcriptEntry = {
      type: "message",
      id: messageId,
      timestamp: new Date(now).toISOString(),
      message: {
        role,
        content: [{ type: "text", text }],
        timestamp: now,
        stopReason: role === "assistant" ? "end_turn" : undefined,
        usage:
          role === "assistant"
            ? { input: 0, output: 0, totalTokens: 0 }
            : undefined,
      },
    };

    appendFileSync(
      transcriptPath,
      `${JSON.stringify(transcriptEntry)}\n`,
      "utf-8",
    );
    logger?.info?.(`wecom: wrote ${role} message to transcript`);
  } catch (err) {
    logger?.warn?.(`wecom: failed to write transcript: ${err.message}`);
  }
}

// 广播消息到 Chat UI
function broadcastToChatUI({ sessionKey, role, text, runId, state }) {
  if (!gatewayBroadcastCtx) {
    return;
  }

  try {
    const chatPayload = {
      runId: runId || `wecom-${Date.now()}`,
      sessionKey,
      seq: 0,
      state: state || "final",
      message: {
        role: role || "user",
        content: [{ type: "text", text: text || "" }],
        timestamp: Date.now(),
      },
    };

    gatewayBroadcastCtx.broadcast("chat", chatPayload);
    gatewayBroadcastCtx.bridgeSendToSession(sessionKey, "chat", chatPayload);
  } catch (err) {
    // ignore
  }
}

const wecomAccounts = new Map();
let defaultAccountId = "default";

const sessionHistories = new Map();
const DEFAULT_HISTORY_LIMIT = 20;

function getWecomConfig(api, accountId = null) {
  const targetAccountId = accountId || defaultAccountId;

  if (wecomAccounts.has(targetAccountId)) {
    return wecomAccounts.get(targetAccountId);
  }

  const cfg = api?.config ?? gatewayRuntime?.config;
  const channelConfig = cfg?.channels?.wecom;
  let callbackToken = channelConfig?.callbackToken;
  let callbackAesKey = channelConfig?.callbackAesKey;
  let webhookPath = channelConfig?.webhookPath || "/wecom/callback";

  if (!callbackToken) {
    callbackToken =
      requireEnv(`WECOM_CALLBACK_TOKEN`) || requireEnv("WECOM_CALLBACK_TOKEN");
  }
  if (!callbackAesKey) {
    callbackAesKey =
      requireEnv(`WECOM_CALLBACK_AES_KEY`) ||
      requireEnv("WECOM_CALLBACK_AES_KEY");
  }

  if (callbackToken && callbackAesKey) {
    const config = {
      accountId: targetAccountId,
      callbackToken,
      callbackAesKey,
      webhookPath,
      enabled: channelConfig?.enabled !== false,
    };
    wecomAccounts.set(targetAccountId, config);
    return config;
  }

  return null;
}

function listWecomAccountIds(api) {
  const cfg = api?.config ?? gatewayRuntime?.config;
  const accountIds = new Set(["default"]);
  return Array.from(accountIds);
}

export default function register(api) {
  gatewayRuntime = api.runtime;

  const cfg = getWecomConfig(api);
  if (cfg) {
    api.logger.info?.(`wecom-aibot: config loaded for smart bot`);
  } else {
    api.logger.warn?.(
      "wecom-aibot: no configuration found (missing callbackToken or callbackAesKey)",
    );
  }

  api.registerChannel({ plugin: WecomAibotPlugin });

  api.registerGatewayMethod("wecom.init", async (ctx, nodeId, params) => {
    gatewayBroadcastCtx = ctx;
    api.logger.info?.("wecom-aibot: gateway broadcast context captured");
    return { ok: true };
  });

  api.registerGatewayMethod("wecom.broadcast", async (ctx, nodeId, params) => {
    const { sessionKey, runId, message, state } = params || {};
    if (!sessionKey || !message) {
      return { ok: false, error: { message: "missing sessionKey or message" } };
    }

    const chatPayload = {
      runId: runId || `wecom-${Date.now()}`,
      sessionKey,
      seq: 0,
      state: state || "final",
      message: {
        role: message.role || "user",
        content: [{ type: "text", text: message.text || "" }],
        timestamp: Date.now(),
      },
    };

    ctx.broadcast("chat", chatPayload);
    ctx.bridgeSendToSession(sessionKey, "chat", chatPayload);

    gatewayBroadcastCtx = ctx;

    return { ok: true };
  });

  const webhookPath = cfg?.webhookPath || "/wecom/callback";
  const normalizedPath =
    normalizePluginHttpPath(webhookPath, "/wecom/callback") ??
    "/wecom/callback";

  api.registerHttpRoute({
    path: normalizedPath,
    handler: async (req, res) => {
      try {
        api.logger.info?.(
          `wecom-aibot DEBUG: ${req.method} request received at ${req.url}`,
        );
        const config = getWecomConfig(api);
        const token = config?.callbackToken;
        const aesKey = config?.callbackAesKey;

        const url = new URL(req.url ?? "/", "http://localhost");
        const msg_signature = url.searchParams.get("msg_signature") ?? "";
        const timestamp = url.searchParams.get("timestamp") ?? "";
        const nonce = url.searchParams.get("nonce") ?? "";
        const echostr = url.searchParams.get("echostr") ?? "";

        if (req.method === "GET" && !echostr) {
          res.statusCode = token && aesKey ? 200 : 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(
            token && aesKey
              ? "wecom webhook ok"
              : "wecom webhook not configured",
          );
          return;
        }

        if (!token || !aesKey) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("WeCom plugin not configured (missing token/aesKey)");
          return;
        }

        if (req.method === "GET") {
          // URL verification for AI Bot
          const expected = computeMsgSignature({
            token,
            timestamp,
            nonce,
            encrypt: echostr,
          });
          if (!msg_signature || expected !== msg_signature) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Invalid signature");
            return;
          }
          const { msg: plainEchostr } = decryptWecom({
            aesKey,
            cipherTextBase64: echostr,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(plainEchostr);
          return;
        }

        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, POST");
          res.end();
          return;
        }

        const rawBody = await readRequestBody(req);
        let incoming;
        try {
          // 智能机器人回调格式为 JSON，而非 XML
          incoming = JSON.parse(rawBody);
        } catch (err) {
          // 容错：如果还是收到 XML 就报错并返回
          api.logger.error?.(
            `wecom-aibot JSON Parse ERROR: ${err.message}, body was: ${rawBody.slice(0, 100)}`,
          );
          res.statusCode = 400;
          res.end("Invalid JSON Body");
          return;
        }

        const encrypt = incoming?.encrypt;
        if (!encrypt) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Missing encrypt field");
          return;
        }

        const expected = computeMsgSignature({
          token,
          timestamp,
          nonce,
          encrypt,
        });

        if (!msg_signature || expected !== msg_signature) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid signature");
          return;
        }

        const { msg: decryptedMsg } = decryptWecom({
          aesKey,
          cipherTextBase64: encrypt,
        });

        // 诊断日志：输出解密后的 JSON Payload
        api.logger.info?.(
          `wecom-aibot DEBUG decrypted Payload: ${decryptedMsg?.slice(0, 500)}`,
        );

        const msgObj = JSON.parse(decryptedMsg);

        // --- 核心流式消息被动响应机制 ---
        const msgType = msgObj.msgtype;

        // 处理流式消息刷新 (stream)
        if (msgType === "stream" && msgObj.stream) {
          api.logger.info?.(
            `wecom-aibot: received stream push request, responding asynchronously.`,
          );
          // 暂时无专门的流式回调实现支持，可以返回空字符包或抛出警告并返回成功
          res.statusCode = 200;
          res.end();
          return;
        }

        // 处理事件消息 (如 enter_chat 进入聊天)
        if (msgType === "event") {
          const eventType = msgObj.event?.eventtype || "unknown";
          api.logger.info?.(
            `wecom-aibot: received event: ${eventType}, skipping AI processing`,
          );
          res.statusCode = 200;
          res.end("success");
          return;
        }

        const fromUser = msgObj.from?.userid;
        const responseUrl = msgObj.response_url;
        const aibotId = msgObj.aibotid || null; // 智能机器人 ID
        const chatId = msgObj.chatid || null;
        const chatType = msgObj.chattype; // 'single' | 'group'
        const isGroupChat = chatType === "group" || !!chatId;

        api.logger.info?.(
          `wecom-aibot inbound: userid=${fromUser} aibotid=${aibotId} msgtype=${msgType} responseUrl=${responseUrl ? "yes" : "no"}`,
        );

        if (!fromUser) {
          api.logger.warn?.(
            "wecom-aibot: No from.userid in incoming message JSON",
          );
          res.statusCode = 200;
          res.end("success");
          return;
        }

        // --- 常规消息被动回复/ACK 机制 ---
        let httpResResolved = false;
        let httpResTimeout = null;
        const resolveHttpResponse = (passiveJsonText = null) => {
          if (httpResResolved) return false;
          httpResResolved = true;
          if (httpResTimeout) clearTimeout(httpResTimeout);

          if (!passiveJsonText) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("success");
            return false;
          } else {
            try {
              const currentTimestamp = Math.floor(Date.now() / 1000).toString();
              const currentNonce = Math.random().toString(36).substring(2, 10);
              const cipherTextBase64 = encryptWecom({
                aesKey,
                text: passiveJsonText,
                receiveId: "",
              });
              const msgSig = computeMsgSignature({
                token,
                timestamp: currentTimestamp,
                nonce: currentNonce,
                encrypt: cipherTextBase64,
              });

              const responseData = JSON.stringify({
                encrypt: cipherTextBase64,
                msg_signature: msgSig,
                timestamp: currentTimestamp,
                nonce: currentNonce,
              });

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(responseData);
              api.logger.info?.(
                `wecom-aibot: sent passive reply synchronously.`,
              );
              return true;
            } catch (err) {
              api.logger.error?.(
                `wecom-aibot: passive reply encryption failed: ${err.message}`,
              );
              res.statusCode = 200;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("success");
              return false;
            }
          }
        };

        // 企微限制回调必须在 5 秒内返回，我们设 4.5 秒超时
        httpResTimeout = setTimeout(() => {
          resolveHttpResponse();
        }, 4500);

        // 提取消息内容
        let content = "";
        let mediaUrl = null;
        let voiceContent = null;
        let msgItemArr = null;

        if (msgType === "text" && msgObj.text) {
          content = msgObj.text.content;
        } else if (msgType === "image" && msgObj.image) {
          mediaUrl = msgObj.image.url;
        } else if (msgType === "voice" && msgObj.voice) {
          voiceContent = msgObj.voice.content;
        } else if (msgType === "file" && msgObj.file) {
          mediaUrl = msgObj.file.url;
        } else if (
          msgType === "mixed" &&
          msgObj.mixed &&
          msgObj.mixed.msg_item
        ) {
          // 图文混排，可以取出文本
          msgItemArr = msgObj.mixed.msg_item;
          msgItemArr.forEach((item) => {
            if (item.msgtype === "text" && item.text) {
              content += item.text.content + "\n";
            } else if (item.msgtype === "image" && item.image) {
              mediaUrl = item.image.url; // 这里只抓取一个图作为代表
            }
          });
        }

        // 保存 responseUrl，以便 processInboundMessage 中的业务逻辑使用
        if (responseUrl) {
          const sessionKey = (
            isGroupChat ? `wecom:group:${chatId}` : `wecom:${fromUser}`
          ).toLowerCase();
          sessionResponseUrls.set(sessionKey, responseUrl);
        }

        // 异步处理消息
        processInboundMessage({
          api,
          fromUser,
          content,
          msgType,
          mediaUrl,
          voiceContent,
          chatId,
          isGroupChat,
          responseUrl,
          resolveHttpResponse,
        }).catch((err) => {
          api.logger.error?.(
            `wecom-aibot: async message processing failed: ${err.message}`,
          );
        });
      } catch (handlerErr) {
        api.logger.error?.(
          `wecom-aibot DEBUG handler error: ${handlerErr.message}\n${handlerErr.stack}`,
        );
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end("Internal error");
        }
      }
    },
  });

  api.logger.info?.(
    `wecom-aibot: registered json webhook at ${normalizedPath}`,
  );
}

async function handleHelpCommand({ api, fromUser, responseUrl }) {
  const helpText = `🤖 AI 助手使用帮助
  
可用命令：
/help - 显示此帮助信息
/clear - 清除会话历史，开始新对话
/status - 查看系统状态

直接发送消息即可与 AI 对话。
支持发送图片进行分析。`;

  await sendWecomMarkdownMessage({ responseUrl, markdownContent: helpText });
  return true;
}

async function handleClearCommand({ api, fromUser, responseUrl }) {
  const sessionId = `wecom:${fromUser}`.toLowerCase();
  try {
    await execFileAsync(
      "clawdbot",
      ["session", "clear", "--session-id", sessionId],
      {
        timeout: 10000,
      },
    );
    clearHistoryEntriesIfEnabled({
      historyMap: sessionHistories,
      historyKey: sessionId,
      limit: DEFAULT_HISTORY_LIMIT,
    });
    await sendWecomMarkdownMessage({
      responseUrl,
      markdownContent: "✅ 会话已清除，我们可以开始新的对话了！",
    });
  } catch (err) {
    api.logger.warn?.(`wecom-aibot: failed to clear session: ${err.message}`);
    clearHistoryEntriesIfEnabled({
      historyMap: sessionHistories,
      historyKey: sessionId,
      limit: DEFAULT_HISTORY_LIMIT,
    });
    await sendWecomMarkdownMessage({
      responseUrl,
      markdownContent: "会话已重置，请开始新的对话。",
    });
  }
  return true;
}

async function handleStatusCommand({ api, fromUser, sessionId, responseUrl }) {
  const config = getWecomConfig(api);
  const accountIds = listWecomAccountIds(api);

  const historyKey = sessionId || `wecom:${fromUser}`.toLowerCase();
  const historyEntries = sessionHistories.get(historyKey) || [];
  const historyCount = historyEntries.length;

  const statusText = `📊 系统状态

**渠道**：企业微信智能机器人 (WeCom Aibot)
**会话ID**：${historyKey}
**账户ID**：${config?.accountId || "default"}
**插件版本**：${PLUGIN_VERSION}

**对话历史**：${historyCount} 条（上限 ${DEFAULT_HISTORY_LIMIT} 条）

**功能状态**：
✅ JSON 协议回调
✅ Markdown 主动回复 (response_url)
✅ 图片/音视频直连下载
✅ 对话历史记忆
✅ API 限流`;

  await sendWecomMarkdownMessage({ responseUrl, markdownContent: statusText });
  return true;
}

const COMMANDS = {
  "/help": handleHelpCommand,
  "/clear": handleClearCommand,
  "/status": handleStatusCommand,
};

// 异步处理入站消息
async function processInboundMessage({
  api,
  fromUser,
  content,
  msgType,
  mediaUrl,
  voiceContent,
  chatId,
  isGroupChat,
  responseUrl,
  resolveHttpResponse,
}) {
  const config = getWecomConfig(api);
  const cfg = api.config;
  const runtime = api.runtime;

  if (!config?.callbackToken || !config?.callbackAesKey) {
    api.logger.warn?.("wecom-aibot: not configured with token and aesKey");
    return;
  }

  try {
    const sessionId = isGroupChat
      ? `wecom:group:${chatId}`.toLowerCase()
      : `wecom:${fromUser}`.toLowerCase();
    api.logger.info?.(
      `wecom-aibot: processing ${msgType} message for session ${sessionId}${isGroupChat ? " (group)" : ""}`,
    );

    if (msgType === "text" && content?.startsWith("/")) {
      const commandKey = content.split(/\s+/)[0].toLowerCase();
      const handler = COMMANDS[commandKey];
      if (handler) {
        api.logger.info?.(`wecom-aibot: handling command ${commandKey}`);
        await handler({
          api,
          fromUser,
          chatId,
          isGroupChat,
          sessionId,
          responseUrl,
        });
        return;
      }
    }

    // 默认第一时间统一发送 ACK 文本，告知用户已接收到消息，防止大模型处理超 4.5 秒造成前端无响应的迷惑感
    if (resolveHttpResponse) {
      resolveHttpResponse(
        JSON.stringify({
          msgtype: "stream",
          stream: {
            id: `ack-${Date.now()}`,
            finish: true,
            content: "✍️ 正在处理问题，请稍候...",
          },
        }),
      );
    }

    let messageText = content || "";

    let imageBase64 = null;
    let imageMimeType = null;

    if (
      (msgType === "image" || (msgType === "mixed" && mediaUrl)) &&
      mediaUrl
    ) {
      api.logger.info?.(
        `wecom-aibot: downloading image mediaUrl=${mediaUrl.slice(0, 50)}...`,
      );

      try {
        let { buffer, contentType, isWecomCorpus } =
          await fetchMediaFromUrl(mediaUrl);

        // --- 增加对图片的 AES 解密 ---
        if (isWecomCorpus && config.callbackAesKey) {
          try {
            let decryptedBuffer = decryptWecom({
              aesKey: config.callbackAesKey,
              cipherBuffer: buffer,
              bufferMode: true,
            });
            if (decryptedBuffer && decryptedBuffer.length > 0) {
              api.logger.info?.(
                `wecom-aibot: successfully decrypted image file from url, origSize=${buffer.length}, newSize=${decryptedBuffer.length}`,
              );
              buffer = decryptedBuffer;
            }
          } catch (decErr) {
            api.logger.warn?.(
              `wecom-aibot: attempt to decrypt image buffer failed, it might be raw: ${decErr.message}`,
            );
          }
        }
        // ------------------------------

        imageBase64 = buffer.toString("base64");
        imageMimeType = contentType || "image/jpeg";
        messageText = messageText
          ? `${messageText}\n[图片在附件中]`
          : "[用户发送了一张图片]";
        api.logger.info?.(
          `wecom-aibot: image downloaded and processed from URL, type=${imageMimeType}`,
        );
      } catch (downloadErr) {
        api.logger.warn?.(
          `wecom-aibot: failed to download image via mediaUrl: ${downloadErr.message}`,
        );
        messageText =
          "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
      }
    }

    if (msgType === "voice" && voiceContent) {
      api.logger.info?.(`wecom-aibot: received voice content from json node`);
      messageText = `[语音消息转文字结果] ${voiceContent}`;
    }

    if (msgType === "file" && mediaUrl) {
      api.logger.info?.(
        `wecom-aibot: received file url=${mediaUrl.slice(0, 50)}...`,
      );
      try {
        let { buffer, contentType, contentDisposition, isWecomCorpus } =
          await fetchMediaFromUrl(mediaUrl);

        // 如果是企微下载域发来的极有可能需要被解密
        if (isWecomCorpus && config.callbackAesKey) {
          try {
            let decryptedBuffer = decryptWecom({
              aesKey: config.callbackAesKey,
              cipherBuffer: buffer,
              bufferMode: true,
            });
            if (decryptedBuffer && decryptedBuffer.length > 0) {
              api.logger.info?.(
                `wecom-aibot: successfully decrypted media file from url, origSize=${buffer.length}, newSize=${decryptedBuffer.length}`,
              );
              buffer = decryptedBuffer;
            }
          } catch (decErr) {
            api.logger.warn?.(
              `wecom-aibot: attempt to decrypt file buffer failed, it might be raw: ${decErr.message}`,
            );
          }
        }

        // 推断文件扩展名
        let ext = "";
        let originalFilename = "";

        // 1. 尝试从 content-disposition 提取真实文件名
        if (contentDisposition) {
          const filenameStarMatch = contentDisposition.match(
            /filename\*=utf-8''([^;]+)/i,
          );
          if (filenameStarMatch && filenameStarMatch[1]) {
            originalFilename = decodeURIComponent(filenameStarMatch[1]);
          } else {
            const filenameMatch = contentDisposition.match(
              /filename="?([^";]+)"?/i,
            );
            if (filenameMatch && filenameMatch[1]) {
              originalFilename = filenameMatch[1];
            }
          }
          if (originalFilename) {
            const extMatch = originalFilename.match(/\.([a-zA-Z0-9]+)$/);
            if (extMatch && extMatch[1]) {
              ext = extMatch[1].toLowerCase();
            }
          }
        }

        // 2. 如果 Content-Disposition 没提取到，退化为根据 Content-Type 映射
        if (!ext) {
          const mimeToExtMap = {
            "application/pdf": "pdf",
            "application/msword": "doc",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
              "docx",
            "application/vnd.ms-excel": "xls",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
              "xlsx",
            "text/csv": "csv",
            "text/markdown": "md",
            "text/plain": "txt",
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/gif": "gif",
            "video/mp4": "mp4",
            "audio/mpeg": "mp3",
            "audio/wav": "wav",
          };
          const cType = contentType?.split(";")[0].trim().toLowerCase() || "";
          ext = mimeToExtMap[cType] || "";
        }

        // 3. 最后尝试 URL 正则
        if (!ext && mediaUrl) {
          const match = mediaUrl.match(/\.([a-zA-Z0-9]+)(?:[\?#]|$)/);
          if (match && match[1]) {
            ext = match[1].toLowerCase();
          }
        }

        let fileName = "file-downloaded-" + Date.now();
        if (originalFilename) {
          // 如果拿到了带中文的真实名字，为了稳妥起见我们把它拼接在后面
          fileName =
            Date.now() + "-" + originalFilename.replace(/[\/\\]/g, "_");
        } else if (ext) {
          fileName += `.${ext}`;
        }

        const workspaceDir = join(
          homedir(),
          ".openclaw",
          "workspace",
          "wecom-files",
        );
        await mkdir(workspaceDir, { recursive: true });
        const fileTempPath = join(workspaceDir, `${Date.now()}-${fileName}`);
        await writeFile(fileTempPath, buffer);
        api.logger.info?.(
          `wecom-aibot: saved file to ${fileTempPath}, size=${buffer.length} bytes`,
        );

        messageText = `[用户发送了一个文件，已保存到: ${fileTempPath}]\n\n请使用合适的工具查看文件内容进行分析。`;
      } catch (downloadErr) {
        api.logger.warn?.(
          `wecom-aibot: failed to download file url: ${downloadErr.message}`,
        );
        messageText = `[用户发送了一个文件，但下载失败]\n\n请告诉用户文件处理暂时不可用。`;
      }
    }

    if (!messageText && !imageBase64) {
      api.logger.warn?.("wecom-aibot: empty message content after process");
      return;
    }

    let imageTempPath = null;
    if (imageBase64 && imageMimeType) {
      try {
        const ext = imageMimeType.includes("png")
          ? "png"
          : imageMimeType.includes("gif")
            ? "gif"
            : "jpg";
        const tempDir = join(tmpdir(), "openclaw-wecom");
        await mkdir(tempDir, { recursive: true });
        imageTempPath = join(
          tempDir,
          `image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
        );
        await writeFile(imageTempPath, Buffer.from(imageBase64, "base64"));
        api.logger.info?.(`wecom-aibot: saved image to ${imageTempPath}`);
        messageText =
          messageText +
          `\n[用户发送的一张图片，已保存到: ${imageTempPath}]\n\n请使用 Read 工具查看这张图片并描述内容。`;
      } catch (saveErr) {
        api.logger.warn?.(
          `wecom-aibot: failed to save image: ${saveErr.message}`,
        );
        messageText =
          "[用户发送了一张图片，但本地保存失败]\n\n请告诉用户图片处理暂时不可用。";
        imageTempPath = null;
      }
    }

    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      sessionKey: sessionId,
      channel: "wecom",
      accountId: config.accountId || "default",
    });

    const storePath = runtime.channel.session.resolveStorePath(
      cfg.session?.store,
      {
        agentId: route.agentId,
      },
    );

    const systemPromptSuffix = `\n\n[系统提示: 如果你需要读取用户之前发送过的文件，它们通常被自动保存在服务器的本地工作区目录: /root/.openclaw/workspace/wecom-files/ (以及 /tmp/openclaw-wecom/)]`;

    // 如果想要将这个提示词隐式加载，可以夹带在真正的 content 后面发送给大模型
    const enrichedMessageText = messageText + systemPromptSuffix;

    const envelopeOptions =
      runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const chatType = isGroupChat ? "group" : "direct";
    const formattedBody = runtime.channel.reply.formatInboundEnvelope({
      channel: "WeComAibot",
      from: fromUser,
      timestamp: Date.now(),
      body: enrichedMessageText,
      chatType,
      sender: {
        name: fromUser,
        id: fromUser,
      },
      envelope: envelopeOptions,
    });

    const body = buildPendingHistoryContextFromMap({
      historyMap: sessionHistories,
      historyKey: sessionId,
      limit: DEFAULT_HISTORY_LIMIT,
      currentMessage: formattedBody,
      formatEntry: (entry) =>
        runtime.channel.reply.formatInboundEnvelope({
          channel: "WeComAibot",
          from: fromUser,
          timestamp: entry.timestamp,
          body: entry.body,
          chatType,
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });

    recordPendingHistoryEntry({
      historyMap: sessionHistories,
      historyKey: sessionId,
      entry: {
        sender: fromUser,
        body: enrichedMessageText,
        timestamp: Date.now(),
        messageId: `wecom-${Date.now()}`,
      },
      limit: DEFAULT_HISTORY_LIMIT,
    });

    const ctxPayload = {
      Body: body,
      RawBody: content || messageText || "",
      From: isGroupChat ? `wecom:group:${chatId}` : `wecom:${fromUser}`,
      To: `wecom:${fromUser}`,
      SessionKey: sessionId,
      AccountId: config.accountId || "default",
      ChatType: chatType,
      ConversationLabel: fromUser,
      SenderName: fromUser,
      SenderId: fromUser,
      Provider: "wecom",
      Surface: "wecom",
      MessageSid: `wecom-${Date.now()}`,
      Timestamp: Date.now(),
      OriginatingChannel: "wecom",
      OriginatingTo: `wecom:${fromUser}`,
      CommandAuthorized: true,
    };

    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: !isGroupChat
        ? {
            sessionKey: sessionId,
            channel: "wecom",
            to: fromUser,
            accountId: config.accountId || "default",
          }
        : undefined,
      onRecordError: (err) => {
        api.logger.warn?.(`wecom-aibot: failed to record session: ${err}`);
      },
    });

    api.logger.info?.(`wecom-aibot: session registered for ${sessionId}`);

    runtime.channel.activity.record({
      channel: "wecom",
      accountId: config.accountId || "default",
      direction: "inbound",
    });

    await writeToTranscript({
      sessionKey: sessionId,
      role: "user",
      text: enrichedMessageText,
      logger: api.logger,
    });

    const inboundRunId = `wecom-inbound-${Date.now()}`;
    broadcastToChatUI({
      sessionKey: sessionId,
      role: "user", // 在 UI 广播时，我们也传给 UI 看吗？通常可以只给大模型看，不过目前 transcripts 是存的 enriched。如果是纯聊天也可以给用户原本的 `messageText`，这里保持一致，或UI层使用 messageText。
      text: messageText,
      runId: inboundRunId,
      state: "final",
    });

    // 注意：文档规定每个 response_url 只能调用 1 次，有效期 1 小时。
    // 因此这里绝对不能发送“处理中”提示，否则会消耗掉唯一一次发消息的机会，导致后续真正的 LLM 回复 60140 失败。
    // https://developer.work.weixin.qq.com/document/path/101138

    api.logger.info?.(
      `wecom-aibot: dispatching message via agent runtime for session ${sessionId}`,
    );

    try {
      const outboundRunId = `wecom-outbound-${Date.now()}`;
      let finalAccumulatedReply = "";

      // 替代 `dispatchReplyWithBufferedBlockDispatcher` 以确保发生 tool 调用的长周期也能等待结束再回传最终结果
      const { dispatchReplyFromConfig } = runtime.channel.reply;

      const replyResult = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher: {
          sendBlockReply: (payload) => {
            if (payload.text) {
              finalAccumulatedReply +=
                (finalAccumulatedReply ? "\n\n" : "") + payload.text;
              writeToTranscript({
                sessionKey: sessionId,
                role: "assistant",
                text: payload.text,
                logger: api.logger,
              }).catch(() => {});
            }
            return false;
          },
          sendFinalReply: (payload) => {
            if (payload.text) {
              finalAccumulatedReply +=
                (finalAccumulatedReply ? "\n\n" : "") + payload.text;
              writeToTranscript({
                sessionKey: sessionId,
                role: "assistant",
                text: payload.text,
                logger: api.logger,
              }).catch(() => {});
            }
            return false;
          },
          waitForIdle: async () => {},
          getQueuedCounts: () => ({ block: 0, final: 0 }),
        },
        replyOptions: {
          onBlockReply: async (payload, context) => {
            if (payload.text) {
              api.logger.info?.(
                `wecom-aibot: buffering intermediate block reply, length=${payload.text.length}`,
              );

              finalAccumulatedReply +=
                (finalAccumulatedReply ? "\n\n" : "") + payload.text;

              await writeToTranscript({
                sessionKey: sessionId,
                role: "assistant",
                text: payload.text,
                logger: api.logger,
              });

              broadcastToChatUI({
                sessionKey: sessionId,
                role: "assistant",
                text: payload.text,
                runId: outboundRunId,
                state: "streaming",
              });
            }
          },
        },
      });

      broadcastToChatUI({
        sessionKey: sessionId,
        role: "assistant",
        text: finalAccumulatedReply,
        runId: outboundRunId,
        state: "final",
      });

      clearHistoryEntriesIfEnabled({
        historyMap: sessionHistories,
        historyKey: sessionId,
        limit: DEFAULT_HISTORY_LIMIT,
      });

      // 所有推理和工具调用都已结束后，将积累的所有最终块文本一次性通过 response_url 返回
      let textToSend = finalAccumulatedReply.trim();

      const doSendResponseUrl = async (content) => {
        try {
          await sendWecomMarkdownMessage({
            responseUrl,
            markdownContent: content,
            logger: api.logger,
          });
          api.logger.info?.(
            `wecom-aibot: sent accumulated AI replies to ${fromUser}, length=${content.length}`,
          );
        } catch (e) {
          api.logger.warn?.(
            `wecom-aibot: accumulated response_url reply failed: ${e.message}`,
          );
        }
      };

      if (responseUrl) {
        if (textToSend) {
          await doSendResponseUrl(textToSend);
        } else {
          api.logger.info?.(
            `wecom-aibot: no text generated to send via response_url.`,
          );
          await doSendResponseUrl(
            "抱歉，处理您的消息时出现错误，请稍后重试。\n错误: 未知错误",
          );
        }
      }
    } finally {
      if (resolveHttpResponse) {
        resolveHttpResponse();
      }
      if (imageTempPath) {
        unlink(imageTempPath).catch(() => {});
      }
    }
  } catch (err) {
    if (resolveHttpResponse) {
      resolveHttpResponse();
    }
    api.logger.error?.(
      `wecom-aibot: failed to process message: ${err.message}`,
    );
    api.logger.error?.(`wecom-aibot: stack trace: ${err.stack}`);

    try {
      if (responseUrl) {
        await sendWecomMarkdownMessage({
          responseUrl,
          markdownContent: `抱歉，处理您的消息时出现错误，请稍后重试。\n错误: ${err.message?.slice(0, 100) || "未知错误"}`,
          logger: api.logger,
        });
      }
    } catch (sendErr) {
      api.logger.error?.(
        `wecom-aibot: failed to send error message: ${sendErr.message}`,
      );
    }
  }
}
