---
locale: zh-CN
---
# DeepSeek reasoning_content 补全

在携带工具的 DeepSeek 思考模式请求发往上游之前，为助手消息补全缺失的 `reasoning_content`。DeepSeek 在助手消息参与工具调用却没有推理文本时返回 HTTP 400；插件补上该字段后，请求可以继续。

这是一个请求处理插件，不是渠道，也不需要 API Key、上游地址或渠道类型。

## 渠道设置

- 在 **请求插件** 中安装插件，并创建一个实例。
- 保持实例启用，把它绑定为全局、绑定到提供 DeepSeek 模型的分组，或绑定到 DeepSeek 渠道。
- 如果渠道会原样直通请求体，请把实例绑定为全局或绑定到分组。只绑定到渠道时没有早期 `ingress`，直通渠道也不会运行 late `ingress`。
- 如果实例只需要覆盖部分客户端模型名，用实例的 **模型** 列表缩小范围。该列表按客户端请求的模型名精确匹配。
- 插件声明了 `optional: true`。插件在某个请求上出错时，网关会记录警告并跳过该实例，不会阻止请求。

插件只处理请求体，不会向上游发送请求，也不会改变模型价格或计费。

## 配置

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| **占位推理内容** | `" "`（一个空格） | 消息本身和它的 provider 字段都没有非空值时写入的推理文本，长度为 1 到 4096 个字符。 |
| **模型关键字** | `deepseek` | 逗号分隔、不区分大小写的模型名片段。留空表示处理所有模型，最多 512 个字符。 |

匹配使用子串判断，因此 `deepseek` 可以匹配 `deepseek-reasoner`、`my-deepseek-proxy` 以及任何包含它的名称。插件会检查上游模型名（可用时）、客户端模型名和请求体中的 `model` 字段。

## 改写内容

只有同时满足以下条件时，插件才会处理请求：

- 请求体是 Chat Completions，即 `ctx.format` 为 `openai`。
- `tools` 是非空数组。
- 没有显式关闭思考：`thinking.type` 不是 `disabled`，`reasoning_effort` 不是 `none`，`reasoning.effort` 也不是 `none`。
- 模型名命中 **模型关键字**。
- `messages` 是数组。

对于每条 `role` 为 `assistant`、且 `reasoning_content` 缺失、为空串或不是字符串的消息，插件会添加 `reasoning_content`。取值按以下顺序选择第一个非空值：

1. `provider_specific_fields.reasoning_content`
2. `reasoning`
3. **占位推理内容**

已有的非空 `reasoning_content` 不会被修改。原来的 provider 字段和 `reasoning` 字段会保留在消息里。空串和 `null` 会被当作缺失并替换。

取值来自 `provider_specific_fields.reasoning_content` 或 `reasoning` 时，插件使用 JSON Patch 的 `copy` 操作，而不是在补丁里重复推理文本。推理内容很长时，插件结果仍然很小。使用占位内容时则是一条简短的 `add` 操作。

有 8 条或更多助手消息需要补字段、且请求没有内联媒体时，插件把它们合并成一次 `replace /messages` 操作，避免网关为每条消息重复解析整包 JSON。更少的消息或带内联媒体的请求仍使用逐条 `copy` 或 `add`。

触发条件是请求带有工具，而不是某条具体的 `tool_calls`。只要 `tools` 非空，所有缺少该字段的助手消息都会被补全，包括不参与工具调用的助手消息。

单个请求最多补全 512 条助手消息，之后的助手消息保持原样。每次发生改写时，请求记录会带有 `deepseek.reasoning_content_filled`，计数为补全的消息数量。

只有合并后的 JSON 不超过 32 MiB 时才使用整体替换；更大的请求退回逐条操作。

## 排查延迟

插件只在上游请求发出前改写请求体，因此首 token 慢可能来自上游模型、长提示词，或网关对改动的审计。管理员的请求日志会在 `other.admin_info.request_plugins` 中列出每个请求插件步骤及其 `duration_ms`。如果插件耗时很小，等待发生在别处。

## 运行阶段

插件导出 `ingress` 和 `outbound`。

- `ingress` 处理客户端请求体。全局或分组实例在请求解析和计价之前运行一次；绑定到渠道的实例在每次渠道尝试时运行 late `ingress`，读取上游请求体。
- `outbound` 在每次渠道尝试时运行，读取为上游构建的 JSON 请求体，位于模型映射和协议转换之后、渠道参数覆盖之前。
- 两个阶段使用同一套判断。已经在 `ingress` 补过的请求不会在 `outbound` 重复添加。
- 直通渠道不会运行 `outbound` 或 late `ingress`。只有实例绑定为全局或分组时，直接发往 `/v1/chat/completions` 的请求才会由早期 `ingress` 处理。
- 渠道参数覆盖在 `outbound` 之后运行，可能替换该字段。

## 模型与接口

插件没有固定的模型列表，处理模型名命中 **模型关键字** 的请求。

| 客户端路径 | 插件可以改写的情况 |
| --- | --- |
| `POST /v1/chat/completions` | 直接使用 Chat Completions。全局或分组实例会在 `ingress` 处理客户端请求体，直通渠道也有效。 |
| `POST /v1/responses` | 仅当渠道把 Responses 请求转换成 Chat Completions。`outbound` 处理转换后的请求体。 |
| `POST /v1/messages` | 仅当渠道把 Claude Messages 转换成 Chat Completions。`outbound` 处理转换后的请求体。 |
| 其他路径或格式 | 通常原样放行；只改写带 `messages` 和 `tools` 的 `openai` 请求体。 |

上游仍使用 Responses 或 Claude 格式的请求不会被处理。上游模型名只在渠道尝试阶段可用，因此早期运行的全局实例看不到渠道的模型映射；绑定到渠道的实例在 late `ingress` 中可以看到。客户端使用不含 `deepseek` 的别名时，请把别名加入 **模型关键字**、留空以处理所有模型，或把实例绑定到渠道。

## 计费

插件没有计费字段，不会改变模型价格。网关按正常流程计费。新增文本会随请求发往上游，可能计入输入 token；默认一个空格的占位内容影响很小。

## 示例

发送一个带工具和助手工具调用的 Chat Completions 请求：

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [
      {"role": "user", "content": "上海现在的天气怎么样？"},
      {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_1",
            "type": "function",
            "function": {"name": "get_weather", "arguments": "{\"city\":\"Shanghai\"}"}
          }
        ]
      },
      {"role": "tool", "tool_call_id": "call_1", "content": "{\"temperature\":22}"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "获取当前天气",
          "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

发往上游的助手消息会补上缺失的字段：

```json
{
  "role": "assistant",
  "content": "",
  "reasoning_content": " ",
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {"name": "get_weather", "arguments": "{\"city\":\"Shanghai\"}"}
    }
  ]
}
```

## 限制

- 只处理 Chat Completions 格式、能按对象读取的 JSON 请求体。表单请求体、非 JSON 请求体和其它协议原样放行。
- 只有 `tools` 非空时才处理。插件不校验 `tool_calls`，也不判断某条助手消息是否真的参与了工具调用。
- 显式关闭思考的请求会被跳过。
- 只改写助手消息，不会给 user、system 或 tool 消息补字段。
- 占位内容不是恢复出来的真实推理，只用于满足字段要求；上游仍可能因为其它原因拒绝请求。
- 已有的非空 `reasoning_content` 不会修改；空串、`null` 和非字符串会被替换。
- 插件不会把请求数据发送到任何地方，也不会在请求之间保留数据。
