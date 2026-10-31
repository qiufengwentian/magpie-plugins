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

多个 key 支持用**逗号、换行或分号**分隔；插件会自动去除首尾空格、空项和重复 key。登录时只用第一个 key 请求一次 `GET /models` 校验，不会逐个 key 发请求。

登录失败时的提示：

- 401/403：提示 **API Key 无效或已过期**；
- 其他非 2xx：提示网关错误；
- 网络异常：提示网络错误；
- 空输入：提示至少填写一个 key。

## 多 key 与请求行为

- 一个 magpie 账号内的多个 key 组成 **API Key Pool**，请求按 round-robin 轮询使用；
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

这两个变量主要用于自建代理、镜像或本地 mock 测试。

## 已知限制

- 只覆盖 AMD TokenFactory 的**公开共享模型**；dedicated 专属部署不在本插件范围。
- 不提供签到、余额、重置时间或计费功能；上游没有这些接口。
- 不实现浏览器 OAuth、设备码登录或 magpie 页面插件。
- 密钥由 magpie 现有 auth 存储管理，插件不额外做加密存储。
- 本插件是兼容层，不修复 AMD 上游网关本身的行为。

## 排错

**登录提示 API Key 无效**

检查 key 是否完整、是否已在 AMD TokenFactory 页面启用，以及是否有首尾空格。

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
