export const meta = {
  apiVersion: 1,
  key: "visduo_deepseek-reasoning-fix",
  name: { en: "DeepSeek reasoning_content fix", zh: "DeepSeek reasoning_content 补全" },
  description: {
    en: "Fills missing reasoning_content on assistant messages so DeepSeek thinking mode with tools stops returning 400",
    zh: "为助手消息补全缺失的 reasoning_content，避免 DeepSeek 思考模式携带工具时返回 400",
  },
  version: "1.0.1",
  author: { name: "多栈科技" },
  website: "https://www.echostack.net/",
  optional: true,
  configSchema: {
    type: "object",
    properties: {
      placeholder: {
        type: "string",
        title: { en: "Placeholder reasoning", zh: "占位推理内容" },
        description: {
          en: "Reasoning text written to an assistant message that has none. A single space is the smallest value DeepSeek accepts",
          zh: "写入缺失推理内容的助手消息的文本，单个空格是 DeepSeek 接受的最小值",
        },
        default: " ",
        minLength: 1,
        maxLength: 4096,
      },
      modelKeywords: {
        type: "string",
        title: { en: "Model keywords", zh: "模型关键字" },
        description: {
          en: "Comma-separated, case-insensitive model name fragments. Leave empty to handle every model",
          zh: "逗号分隔、不区分大小写的模型名片段，留空表示处理所有模型",
        },
        default: "deepseek",
        maxLength: 512,
      },
    },
  },
};

// 单次请求最多 512 条 json.patch 操作。
const MAX_PATCH_OPS = 512;

// 判断是否普通对象（排除 null 与数组）。
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 空串、null 和缺失都算没有推理内容。
function filled(value) {
  return typeof value === "string" && value.length > 0;
}

// 客户端显式关闭思考时不需要补 reasoning_content。
function thinkingDisabled(body) {
  const thinking = body.thinking;
  if (isObject(thinking) && thinking.type === "disabled") return true;
  if (body.reasoning_effort === "none") return true;
  const reasoning = body.reasoning;
  if (isObject(reasoning) && reasoning.effort === "none") return true;
  return false;
}

// 只有携带 tools 的请求才要求回传 reasoning_content。
function hasTools(body) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

// 按配置的关键字匹配模型；客户端模型别名与上游模型名都参与匹配。
function modelMatches(ctx, body, keywords) {
  if (typeof keywords !== "string" || keywords.trim() === "") return true;
  const parts = keywords.split(",");
  const names = [];
  if (typeof ctx.upstreamModel === "string") names.push(ctx.upstreamModel);
  if (typeof ctx.model === "string") names.push(ctx.model);
  if (isObject(body) && typeof body.model === "string") names.push(body.model);
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const part of parts) {
      const keyword = part.trim().toLowerCase();
      if (keyword !== "" && lower.indexOf(keyword) >= 0) return true;
    }
  }
  return false;
}

// 优先沿用消息里已有的推理文本，最后才用占位值。
// 已有文本用 copy 操作引用原路径，避免把大段推理内容复制进补丁。
function reasoningText(message, placeholder) {
  if (isObject(message.provider_specific_fields) && filled(message.provider_specific_fields.reasoning_content)) {
    return message.provider_specific_fields.reasoning_content;
  }
  if (filled(message.reasoning)) return message.reasoning;
  return placeholder;
}

function reasoningOperation(message, index, placeholder) {
  if (isObject(message.provider_specific_fields) && filled(message.provider_specific_fields.reasoning_content)) {
    return {
      op: "copy",
      from: "/messages/" + index + "/provider_specific_fields/reasoning_content",
      path: "/messages/" + index + "/reasoning_content",
    };
  }
  if (filled(message.reasoning)) {
    return {
      op: "copy",
      from: "/messages/" + index + "/reasoning",
      path: "/messages/" + index + "/reasoning_content",
    };
  }
  return {
    op: "add",
    path: "/messages/" + index + "/reasoning_content",
    value: placeholder,
  };
}

// 单次 replace /messages 的补丁体积上限。超过时退回逐条操作，
// 避免把媒体占位符或超大请求体塞进一次 replace。
const MAX_REPLACE_BYTES = 32 << 20;
// 少量消息逐条 copy 更省事；消息较多时合并，避免网关重复解析整包 JSON。
const MIN_REPLACE_MESSAGES = 8;

// 请求体里是否内联了媒体。网关会把它们替换成 [media:N]，
// 而 json.patch 的 value 不允许包含这个占位符。
function hasInlineMedia(value, depth) {
  if (depth > 64) return true;
  if (typeof value === "string") return value.indexOf("data:") >= 0 || value.indexOf("[media:") >= 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasInlineMedia(item, depth + 1)) return true;
    }
    return false;
  }
  if (isObject(value)) {
    if (value.type === "base64" && filled(value.data)) return true;
    if (isObject(value.inlineData) && filled(value.inlineData.data)) return true;
    if (isObject(value.inline_data) && filled(value.inline_data.data)) return true;
    for (const key of Object.keys(value)) {
      if (hasInlineMedia(value[key], depth + 1)) return true;
    }
  }
  return false;
}

// 为每个缺少 reasoning_content 的 assistant 消息生成一条操作。
// 同一路径的 add 或 copy 在 RFC 6902 里等价于覆盖，所以空串与 null 也会被替换。
// 长对话合并为一次 replace /messages，避免网关为每条补丁重复解析整包 JSON。
function buildPatch(body, placeholder, allowReplace) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  const missing = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isObject(message) || message.role !== "assistant") continue;
    if (filled(message.reasoning_content)) continue;
    missing.push(i);
    if (missing.length >= MAX_PATCH_OPS) break;
  }
  if (missing.length === 0) return null;
  if (allowReplace && missing.length >= MIN_REPLACE_MESSAGES) {
    const messagesCopy = messages.slice();
    for (const i of missing) {
      const message = messages[i];
      const next = Object.assign({}, message);
      next.reasoning_content = reasoningText(message, placeholder);
      messagesCopy[i] = next;
    }
    const replacement = [{ op: "replace", path: "/messages", value: messagesCopy }];
    if (JSON.stringify(replacement).length <= MAX_REPLACE_BYTES) {
      return { ops: replacement, count: missing.length };
    }
  }
  const ops = [];
  for (const i of missing) {
    if (ops.length >= MAX_PATCH_OPS) break;
    ops.push(reasoningOperation(messages[i], i, placeholder));
  }
  return { ops: ops, count: ops.length };
}

// 读取实例配置；配置缺失时退回默认值。
function configString(ctx, name, fallback) {
  const config = isObject(ctx.config) ? ctx.config : {};
  return typeof config[name] === "string" ? config[name] : fallback;
}

// 只处理上游为 Chat Completions、带 tools 的 DeepSeek 思考模式请求。
function prepare(ctx, req) {
  if (ctx.format !== "openai") return null;
  const body = req.body;
  if (!isObject(body)) return null;
  if (!hasTools(body)) return null;
  if (thinkingDisabled(body)) return null;
  if (!modelMatches(ctx, body, configString(ctx, "modelKeywords", "deepseek"))) return null;
  const media = Array.isArray(req.media) ? req.media : [];
  return buildPatch(
    body,
    configString(ctx, "placeholder", " "),
    media.length === 0 && !hasInlineMedia(body.messages, 0),
  );
}

function result(ctx, req) {
  const patch = prepare(ctx, req);
  if (!patch) return { action: "continue" };
  return {
    action: "continue",
    effects: [{ type: "json.patch", ops: patch.ops }],
    findings: [{ rule: "deepseek.reasoning_content_filled", count: patch.count }],
  };
}

// 客户端直接发 Chat Completions 时在入口补全，直通渠道也能生效。
export function ingress(ctx, req) {
  return result(ctx, req);
}

// 协议转换后的上游请求再补一次，覆盖 Claude / Responses 等客户端。
// 已补全的请求不会重复改写。
export function outbound(ctx, req) {
  return result(ctx, req);
}
