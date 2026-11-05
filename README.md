# magpie-agentrouter-fix

AgentRouter 的 [Magpie](https://github.com/yetone/magpie) provider 插件：发给上游的 Responses 请求先经过滤，跨账号的历史记录 ID 与加密推理密文不会离开本机。

过滤规则移植自本机已验证的 Codex 过滤层 `fix/proxy.cjs`（同一作者的独立脚本，语义保持一致），专门解决历史 reasoning 密文与历史条目 ID 引发的上游报错（"The requested item was created under a different ... resource"、密文解密失败、"Unknown parameter" 等）。

唯一模型请求路径：

```text
Codex → Magpie 网关 → 本插件 fetch → 请求过滤 → AgentRouter
```

Magpie 负责插件生命周期、账号凭据、网关路由和协议转换（Chat／Anthropic → Responses）；插件在 `auth.loader` 返回的 `fetch` 里负责上游鉴权、请求过滤与转发。

## 环境要求

- Magpie 0.1.2959（开发与宿主集成验证所用版本；更早或更晚版本未测试）
- 插件运行在 Magpie 自带的 Bun 上；本机自动化测试另需 Node（开发用 20.19.3）或 Bun（1.3.14）
- 无运行时第三方依赖，无构建步骤

## 安装

```sh
magpie plugin add /absolute/path/to/magpie-agentrouter-fix
```

## 登录

```sh
magpie plugin login agentrouter-fix
```

只有一个普通 API Key 登录方法：

- **API Key**（必填）：AgentRouter 站点生成的 `sk-…` 密钥，由 Magpie 保存。
- **上游地址**（可选）：默认 `https://ps.air-outer.com`。接受站点 origin 或以 `/v1` 结尾的基址；会规范化为 `<origin>/v1`，不重复拼接。带账号密码、查询参数、片段或其他路径的地址在登录时即被拒绝。

## 模型选择

模型列表从账号自己的 `/v1/models` 读取（同样的地址、密钥与客户端标识），不做静态列表。列表失败时抛错，由 Magpie 展示并沿用其既有缓存机制；插件不把失败伪装成成功列表，也不引入未核实的模型、上下文长度、价格或免费标记。

```sh
magpie provider models agentrouter-fix
magpie provider test agentrouter-fix
```

## 实际过滤内容

对发往模型端点的 `POST /v1/responses`（含尾部斜杠）：

- 删除 `input` 中整个 `type: reasoning` 历史条目。
- 从 `include` 中删除 `reasoning.encrypted_content`，保留其他值。
- 设置 `store: false`。
- 删除普通消息、`function_call`／`function_call_output`、`custom_tool_call`／`custom_tool_call_output` 的顶层 `id`（可重新提交完整内容的记录 ID）；工具 `call_id`、参数与结果、消息正文、图片、文件引用、`phase`、嵌套资源 ID 原样保留。
- 删除 Codex 私有元数据 `internal_chat_message_metadata_passthrough.content_item_metadata`（被上游拒绝的键）；`content_item_kinds`、`turn_id`、`create_time` 等认可键透传。
- 保留本轮 `reasoning.effort` 等参数；其他工具或未知字段不做额外转换。
- 过滤不改调用方原对象；重复过滤幂等。

副作用：丢弃模型前轮的内部推理状态，可能影响复杂任务的连续表现；它针对历史密文导致的解密失败，不保证解决所有上游报错。

## 明确拒绝的场景

以下请求不放行、不发送上游，返回带 `error.type`／`error.code`／`error.message` 的 JSON：

| 场景 | 状态 | code |
| --- | --- | --- |
| `previous_response_id` / `conversation` 引用 | 400 | `response_reference_not_portable` |
| input 中的 `compaction`、`item_reference` 或其他 `encrypted_content` 条目 | 400 | `encrypted_context_not_portable` |
| `context_management` 启用 compaction | 400 | `encrypted_compaction_disabled` |
| `/responses/compact` 端点 | 409 | `encrypted_compaction_disabled` |
| 非法 JSON、`include`/`input` 类型错误 | 400 | `invalid_request_json` 等 |
| 正文超过 64 MiB（含压缩解码后超限） | 413 | `request_too_large` |
| 运行时无法解码的 `Content-Encoding` | 415 | `unsupported_content_encoding` |

接续长会话：请先让模型给出任务文本摘要，再新建会话。注意 Magpie 网关自身也会拦下 `/responses/compact`（"not supported for Magpie models"），插件的拒绝是防御性的第二道。

## 转发与压缩

- 上游 JSON、SSE 及 4xx/5xx 的正文与状态直接传递；不加错误重分类、不重放、不自动重试（模型请求只发一次；Magpie 自身的路由回退属宿主行为）。网络失败与取消沿用 Fetch 错误传播。
- 重写正文后清除旧的 `content-length`、`content-encoding`、`transfer-encoding`、`content-digest`、`expect`，由 Fetch 计算新长度，`Content-Type` 固定 JSON。
- 请求 `Content-Encoding` 解码（运行时内置能力，无新增依赖）：

  | 编码 | Bun（宿主运行时）1.3.14 | Node 20.19.3 |
  | --- | --- | --- |
  | gzip / deflate / br | 支持 | 支持 |
  | zstd | 支持 | 不支持（返回 415） |

- 请求头：覆盖 `Authorization: Bearer <账号密钥>`（不转发客户端访问 Magpie 的凭据）；模型 API 请求默认带 Codex 兼容 `User-Agent: codex_cli_rs/0.101.0`（与可用的 agentrouter 插件相同的兼容标识）。该标识是兼容默认值，其在上游的实际有效性见下方验证记录。
- 代理：使用 Magpie 的原生账号代理能力（宿主为每次 fetch 注入），插件不自建代理。
- 上游响应读取由请求的取消信号控制：客户端取消后，插件侧读取立即终止。实测 Bun 1.3.14 的 fetch 在响应开始后不会拆除已建立的上游 TCP 连接（Node 会立即关闭）；连接残留是宿主运行时限制，读取已停止、正文不继续累积。

## 限制

- 首版只承诺 Codex／Responses HTTP+SSE 客户端。Chat／Anthropic 的协议转换由 Magpie 完成，这些客户端未逐一验证。
- WebSocket 传输不经插件 fetch（宿主以 HTTP/SSE 与插件通信，已核对宿主代码）；`fix` 的 426 防御在插件形态不适用。
- ID 清理覆盖 Codex 常见的普通消息及函数/自定义工具记录；其他依赖服务器资源的工具记录保留其 ID，不保证跨上游可移植。
- 过滤实现以 `request.mjs` 为唯一实现；仓库里的 `fix/` 是兼容基线，两者不会自动同步，规则变更须通过行为测试对照（`plugin.test.mjs` 直接与 `fix/proxy.cjs` 比对同一批输入）。

## 测试

```sh
cd magpie-agentrouter-fix
node --test plugin.test.mjs   # Node 20
bun test plugin.test.mjs      # Bun 1.3.14（宿主运行时）
```

测试使用本机模拟上游与模拟密钥，不调用收费模型。覆盖：过滤行为与 `fix/proxy.cjs` 逐输入对齐（正文、计数、错误码）、端点规范化、正文大小限制、压缩处理、JSON 错误响应、SSE 首包及时转发、客户端取消、上游状态透传、账号隔离、模型列表结构校验。

## 验证记录

日期：2026-11-05。宿主：Magpie 0.1.2959（macOS arm64，本机已装）；运行时：Bun 1.3.14、Node 20.19.3。

自动化测试（均通过，退出码 0）：

```sh
node --test --test-timeout=15000 --test-reporter=tap plugin.test.mjs   # 20/20 pass
bun test plugin.test.mjs                                               # 20/20 pass
```

宿主集成（隔离临时 HOME，未改动日常 Magpie／Codex 配置；模拟上游 127.0.0.1:18191，模拟密钥）：

- `magpie plugin add <本地路径>` ✓ 插件加载，provider 行显示 `agentrouter-fix (AgentRouter Fix)`。
- `magpie plugin login agentrouter-fix` ✓ endpoint 提示与校验生效；非法地址被拒，合法地址登录成功。
- `magpie provider models agentrouter-fix` ✓ 2 个模型来自账号 `/v1/models`，名称与 limit 来自上游字段。
- `magpie provider test agentrouter-fix` ✓ 经真实网关 → AI SDK（`@ai-sdk/openai` responses）→ 插件 fetch → 上游，4–7 ms 返回。
- 模拟上游收到的实际请求：`POST /v1/responses`，`Authorization: Bearer <账号密钥>`、`User-Agent: codex_cli_rs/0.101.0`、正文 `store:false` 已设置、无历史 reasoning、无历史条目 ID。
- 双账号隔离 ✓ 两个账号（`agentrouter-fix` 与 `agentrouter-fix#…`）各自 loader 使用各自密钥与地址，无串号。
- 宿主 models 错误展示 ✓ 未登录时 models hook 抛错，宿主记录并显示该错误。

未执行 / 待验证：

- **真实 AgentRouter 接入未验证**：未用真实密钥经真实上游发送模型请求，`codex_cli_rs/0.101.0` User-Agent 与鉴权在真实上游的有效性未确认。
- 真实 Codex CLI 的连续对话、函数/自定义工具历史、compaction 拒绝提示：未执行。
- 更多 Magpie 版本、Windows/Linux 宿主：未测试。

## 许可

Apache-2.0，见 LICENSE。过滤规则移植自作者本人的 `fix/proxy.cjs`；插件接口遵循 Magpie 公开的 provider-plugin 契约，未复制其他插件的代码（接口结构参考了在用的 agentrouter 插件）。
