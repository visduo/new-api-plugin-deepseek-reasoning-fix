---
translations:
  zh-CN: README.zh-CN.md
---
# DeepSeek reasoning_content fix

Fills missing `reasoning_content` on assistant messages before a DeepSeek thinking-mode request with tools reaches the upstream API. DeepSeek returns HTTP 400 when an assistant message that took part in a tool call has no reasoning text. The plugin adds the field so the request can continue.

This is a request processing plugin. It is not a channel and needs no API key, upstream address, or channel type.

## Channel setup

- Install the plugin under **Request plugins** and create an instance.
- Keep the instance enabled and bind it globally, to the groups that serve DeepSeek models, or to the DeepSeek channels.
- For a channel that passes the request body through unchanged, bind the instance globally or to a group. A channel-only binding has no early `ingress`, and a pass-through channel runs no late `ingress`.
- Use the instance's **Models** list when the instance should only cover some client model names. The list matches the model the client asked for exactly.
- The plugin declares `optional: true`. If the plugin fails on a request, the gateway logs a warning and skips the instance instead of stopping the request.

The plugin works on the request body. It does not send requests upstream and does not change model prices or billing.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| **Placeholder reasoning** | `" "` (one space) | Reasoning text written when neither the message nor its provider fields contain a non-empty value. It accepts 1 to 4096 characters. |
| **Model keywords** | `deepseek` | Comma-separated, case-insensitive model name fragments. Leave it empty to handle every model. The value is limited to 512 characters. |

Matching is a substring test, so `deepseek` matches `deepseek-reasoner`, `my-deepseek-proxy`, and any other name that contains it. The plugin checks the upstream model name when available, the client model name, and the body's `model` field.

## What it changes

The plugin handles a request only when all of these are true:

- The body is Chat Completions, so `ctx.format` is `openai`.
- `tools` is a non-empty array.
- Thinking is not explicitly disabled: `thinking.type` is not `disabled`, `reasoning_effort` is not `none`, and `reasoning.effort` is not `none`.
- A model name matches **Model keywords**.
- `messages` is an array.

For every `assistant` message whose `reasoning_content` is missing, an empty string, or not a string, the plugin adds `reasoning_content`. The value is taken from the first non-empty value among:

1. `provider_specific_fields.reasoning_content`
2. `reasoning`
3. **Placeholder reasoning**

Existing non-empty `reasoning_content` values are left unchanged. The original provider field and `reasoning` field stay in the message. An empty string or `null` is treated as missing and replaced.

When the value comes from `provider_specific_fields.reasoning_content` or `reasoning`, the plugin emits a JSON Patch `copy` operation instead of repeating the text in the patch. This keeps the plugin result small when reasoning text is long. The placeholder case uses a short `add` operation.

When eight or more assistant messages need the field and the request has no inline media, the plugin combines them into one `replace /messages` operation. This avoids the gateway re-parsing the body once per message. Smaller conversations and requests with inline media use per-message `copy` or `add` operations.

The trigger is the presence of tools, not a particular `tool_calls` entry. Once a request has a non-empty `tools` array, every assistant message missing the field is filled, including assistant messages that are not part of a tool call.

At most 512 assistant messages are filled in one request. Assistant messages after that limit are left unchanged. Each changed request records the finding `deepseek.reasoning_content_filled` with the number of messages filled.

A combined replacement is used only when its JSON is at most 32 MiB. A larger request falls back to per-message operations.

## Checking latency

The plugin changes the request before it is sent upstream, so a slow first token can come from the upstream model, a long prompt, or the gateway's audit of the changes. The administrator's request log shows each request plugin step under `other.admin_info.request_plugins`, including its `duration_ms`. A small plugin duration means the wait is elsewhere.

## Stages

The plugin exports `ingress` and `outbound`.

- `ingress` runs on the client body. A global or group instance runs once before the request is parsed and priced. A channel-bound instance runs its late `ingress` on each channel attempt, on the upstream body.
- `outbound` runs once per channel attempt on the JSON body built for upstream, after model mapping and protocol conversion, before the channel's parameter override.
- Both stages apply the same rules. A request already filled at `ingress` is not changed again.
- A channel that passes the body through unchanged does not run `outbound` or a late `ingress`. A direct Chat Completions request is covered by the early `ingress` only when the instance is global or group-bound.
- The channel's parameter override runs after `outbound` and can replace the field.

## Models and endpoints

The plugin has no fixed model list. It handles any model whose name matches **Model keywords**.

| Client path | When the plugin can change the request |
| --- | --- |
| `POST /v1/chat/completions` | Direct Chat Completions. A global or group instance fills the client body at `ingress`, including on a pass-through channel. |
| `POST /v1/responses` | Only when the channel converts the Responses request to Chat Completions. `outbound` fills the converted body. |
| `POST /v1/messages` | Only when the channel converts Claude Messages to Chat Completions. `outbound` fills the converted body. |
| Other paths or formats | Normally pass through; only an `openai` body with `messages` and `tools` is changed. |

Requests that stay in the Responses or Claude format upstream are not handled. The upstream model name is only known during a channel attempt, so an early global instance cannot see a channel's model mapping. A channel-bound instance runs late and does see it. If the client uses an alias that does not contain `deepseek`, add the alias to **Model keywords**, leave the setting empty, or bind the instance to the channel.

## Billing

The plugin has no usage fields and does not change model prices. The gateway bills the request as usual. The added text becomes part of the upstream request and may count as input tokens; the default one-space placeholder has a negligible effect.

## Example

Send a Chat Completions request with tools and an assistant tool call:

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [
      {"role": "user", "content": "What is the weather in Shanghai?"},
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
          "description": "Get the current weather",
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

The assistant message sent upstream gains the missing field:

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

## Limits

- Only JSON object bodies in Chat Completions format are handled. Form bodies, non-JSON bodies, and other protocols pass through.
- Only requests with a non-empty `tools` array are handled. The plugin does not validate `tool_calls` or check that an assistant message belongs to a tool call.
- Requests that explicitly disable thinking are skipped.
- Only assistant messages are changed. User, system, and tool messages are not filled.
- The placeholder is not recovered reasoning. It satisfies the field requirement but does not recreate the model's original reasoning, and the upstream may still reject the request for another reason.
- A non-empty existing `reasoning_content` is never changed. Empty strings, `null`, and non-string values are replaced.
- The plugin does not send request data anywhere and keeps nothing between requests.
