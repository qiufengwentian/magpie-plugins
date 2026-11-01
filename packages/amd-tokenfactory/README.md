# magpie-plugin-amd-tokenfactory

[magpie](https://usemagpie.ai) 供应商插件：把 **AMD TokenFactory（Radeon Cloud）** 的公开共享模型接入 magpie。安装后可用 `amd/<模型 ID>` 访问，和其他供应商一样。

## 上游 API

| 项 | 值 |
| --- | --- |
| Provider id | `amd` |
| Base URL | https://developer.amd.com.cn/radeon/api/v1 |
| 鉴权 | `Authorization: Bearer <AMD API key>` |
| 模型目录 | `GET /models` |
| 推理 | `POST /chat/completions`（OpenAI 兼容，流式透传） |
| 负载状态 | `GET https://developer.amd.com.cn/radeon/api/tokenfactory/load`（无需 key） |

API key 在 [developer.amd.com.cn/radeon/tokenfactory](https://developer.amd.com.cn/radeon/tokenfactory) 申请。

## 安装

从 npm 安装：

~~~bash
magpie plugin add magpie-plugin-amd-tokenfactory
~~~

从本地目录安装：

~~~bash
magpie plugin add /path/to/magpie-plugins/packages/amd-tokenfactory
~~~

从 git 仓库安装时，把上面的本地路径换成仓库中的 `packages/amd-tokenfactory` 目录即可。

## 登录

插件提供一个“粘贴 API key”的登录入口：

1. 打开 https://developer.amd.com.cn/radeon/tokenfactory 申请 API key；
2. 在 magpie 登录框粘贴一个或多个 key；
3. 可选填写备注名，用于区分多个 AMD 账号；
4. 点击登录。

多个 key 支持用**逗号、换行或分号**分隔；插件会自动去除首尾空格、空项和重复 key。

### 登录探活（Key Probe）

登录时插件对每个 key 发起一次 `GET /models` 探活（内部沿用 429/502/503/504 的重试策略），按 HTTP 状态决定它是否进池：

- **并发上限 4**：同时最多 4 个探活请求在飞，key 再多也不会一次性压满上游；
- **单 key 超时 5 秒**：一次探活（含内部重试与退避）超过 5 秒即放弃该 key；
- **总预算 10 秒**：整轮探活最多 10 秒，到点后还没轮到发请求的 key 直接记为未验证，不再补发；
- **三态判定**：`2xx` 判为**存活**；`401/403` 判为**无效**；其他非 2xx、超时、网络异常和预算耗尽一律判为**未验证**。

**入池规则**：存活与未验证的 key 进入池，顺序与粘贴顺序一致；无效的 key 被剔除——这就是“某个 key 登录后不见了”的原因。只要还有 key 存活，登录就成功；只有**零存活**才失败：

- 多 key 全部无效：**所有 N 个 API Key 均无效或已过期，请重新登录**；
- 多 key 零存活但有未验证：**key 探活失败：N 个 key 均未通过（I 个无效，U 个未出结论）**；
- 单 key 401/403：**API Key 无效或已过期（HTTP 401）**，403 时括号里换成 403；
- 单 key 其他非 2xx：**key 校验失败：HTTP 500**，状态码按上游实际值替换；
- 单 key 超时或网络异常：**key 校验失败：超时或网络异常**；
- 空输入：**请至少填写一个 AMD TokenFactory API Key**。

登录成功提示的是**实际入池数量**：多 key 为 **已配置 N 个 AMD TokenFactory API key，请求将轮换使用。**，有剔除或未验证时追加 **（K 个无效已剔除，J 个未验证）**，只列非零项；单 key 为 **已配置 AMD TokenFactory API key（掩码）。**。账号名默认取池中第一个 key 的掩码，入池多于 1 个时追加 `+N`（N 为实际入池数量）；填了备注名则用备注。

探活中第一个存活 key 返回的模型列表会直接写入目录缓存（10 分钟），所以登录成功后立刻打开模型选择器不会再多发一次 `GET /models`；目录解析失败或为空时静默跳过，不影响登录结果。

## 多 key 与请求行为

- 一个 magpie 账号内的多个 key 组成 **API Key Pool**，请求按 round-robin 轮询使用；登录时被剔除的无效 key 不在池内；
- 聊天请求遇到 401、403 或 429 时自动切换到下一个 key，同一请求内每个 key 最多尝试一次；
- 上游 5xx **不**切换 key，避免把网关故障放大成整池请求；
- 所有 key 都失败时，把上游最后返回的响应交给 magpie；
- 请求不伪造 `X-Magpie-Sign-In`，登录失效只在明确 token 失效时报告。

## 模型目录

- 运行时请求 `GET /models`，不在插件里硬编码模型列表；
- 以 models.dev 的 AMD 条目为元数据基底，合并上游返回的上下文长度、最大输出和工具/视觉/推理能力；
- 只保留文本聊天模型，过滤 embedding、rerank、guard、OCR、TTS 等非聊天模型；
- 目录在进程内缓存 10 分钟；
- 目录请求失败时回退到 models.dev 数据，不把普通网关错误误报成登录失效；
- 所有 key 在 `/models` 上都返回 401/403 时，账号会显示登录失效。

## 网关兼容层

AMD 的 OpenAI 兼容网关有一些已知差异，插件在转发前自动处理：

- 删除网关会静默丢弃的参数：`stop`、`seed`、`logit_bias`、`logprobs`、`top_logprobs`、`n`、`user`；
- 把所有 system 消息稳定移动到 messages 数组最前，保持相对顺序；
- Kimi 系模型的 assistant 历史缺少 `reasoning_content` 时补一个空格占位；
- thinking 模型（DeepSeek R1/V4、Kimi K2/K3、GLM 5、GPT-OSS、QwQ 等）已有 `max_tokens` 且小于 16384 时提升到 16384；原本没有该字段时不新增；
- 聊天流式响应原样透传，不增加额外重试层。

## Quota 页面

quota 页面显示：

- 计划：**Free**；
- **API keys**：当前账号保存的 key 数量；
- **Fleet 负载**：可用、总数、Busy、满载和平均利用率。

Fleet 负载查询最长等待 30 秒，结果缓存 5 分钟；失败或超时显示“负载暂不可用”，不会伪造 0，也不会把账号标记为登录失效。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AMD_TOKENFACTORY_BASE_URL` | https://developer.amd.com.cn/radeon/api/v1 | 覆盖 API Base URL |
| `AMD_TOKENFACTORY_LOAD_URL` | https://developer.amd.com.cn/radeon/api/tokenfactory/load | 覆盖 Fleet 负载地址 |
| `AMD_TOKENFACTORY_PROBE_TIMEOUT_MS` | 5000 | 单 key 探活超时（毫秒），仅用于测试压缩时间 |
| `AMD_TOKENFACTORY_PROBE_BUDGET_MS` | 10000 | 整轮探活总预算（毫秒），仅用于测试压缩时间 |

前两个变量主要用于自建代理、镜像或本地 mock 测试；两个探活变量只用于测试压缩时间，未设置或填入非法值时回退默认值，默认值即生产值。

## 已知限制

- 只覆盖 AMD TokenFactory 的**公开共享模型**；dedicated 专属部署不在本插件范围。
- 不提供签到、余额、重置时间或计费功能；上游没有这些接口。
- 不实现浏览器 OAuth、设备码登录或 magpie 页面插件。
- 密钥由 magpie 现有 auth 存储管理，插件不额外做加密存储。
- 本插件是兼容层，不修复 AMD 上游网关本身的行为。

## 排错

**登录提示 API Key 无效**

检查 key 是否完整、是否已在 AMD TokenFactory 页面启用，以及是否有首尾空格。

**登录后 key 数量变少**

被剔除的 key 在探活时返回了 401/403（无效），所以不再入池；提示里写了“未验证”的 key 仍在池内，那是探活超时、网关异常或预算耗尽没拿到结论，可以稍后重新登录再确认。

**聊天一直 429**

多 key 池会轮询，但每个 key 的共享额度仍有限；可减少并发（`maxConcurrency` 默认 4）或增加可用 key。

**模型列表为空或不是最新**

目录缓存 10 分钟；等待缓存过期后重试。若所有 key 都失效，重新登录。

**Quota 页面显示“负载暂不可用”**

Fleet 接口较慢或暂时不可用；API keys 数量和其他功能不受影响。等待 5 分钟缓存过期后再看。

## 开发

~~~bash
npm run check:amd-tokenfactory
npm run test:amd-tokenfactory
~~~

测试使用 Node 内置 `node:test` 和本地 mock HTTP server，不访问真实 AMD 端点。可选的真实端点冒烟（不提供 key 时只验证公开端点）：

~~~bash
AMD_LIVE_TEST=1 npm run test:amd-tokenfactory
~~~

真实聊天冒烟需要另外提供有效 key；默认测试不会读取或要求真实 key。

## 免责

本项目仅用于个人学习与研究，与 AMD 无任何关联，未获得其授权、认可或赞助。
