# AMD TokenFactory Provider Glossary

本词汇表定义 AMD TokenFactory 插件包中的领域术语；实现细节不在此展开。

## Provider

magpie 中注册的一类模型供应来源。本插件的 Provider 是 AMD TokenFactory，provider id 为 `amd`。

## Shared Model

AMD TokenFactory 提供给多个用户共享使用的公开免费模型。插件只覆盖 Shared Model；dedicated 专属部署不在范围内。

## API Key Pool

一个 magpie 账号内保存的一组 AMD API Key。请求按轮询顺序使用这些 key；遇到 401、403 或 429 时切换到下一个 key。

## Fleet Load

AMD TokenFactory 的 `/tokenfactory/load` 接口返回的模型队列负载快照。每个模型条目使用 state（idle、busy、full）和 utilization 表示当前负载；插件把它汇总为可用、总数、Busy、满载和平均利用率。

## Sign-in State

magpie 对 Provider 登录是否仍然有效的标记。插件只在 authorize 明确返回无效 key，或 provider.models 的所有 key 都返回 401/403 时报告登录失效；auth.usage 和普通网关错误不会改变登录状态。

## Gateway Compatibility Layer

插件在把请求转发给 AMD 网关前执行的兼容处理，包括删除不支持的参数、整理 system 消息顺序、为 Kimi 历史补 reasoning_content，以及为 thinking 模型保证最大输出预算。

## Model Catalog

插件通过 `GET /models` 获取的可用模型目录。Model Catalog 与 models.dev 元数据合并后生成 magpie 的运行时模型定义，并在进程内缓存 10 分钟。
