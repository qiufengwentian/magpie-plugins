# magpie-plugins

magpie 插件集合。每个插件位于 packages/ 下，拥有独立的 package.json，可单独安装、测试和发布。

## 插件

- [AMD TokenFactory](packages/amd-tokenfactory/README.md) — 把 AMD TokenFactory（Radeon Cloud）的公开共享模型接入 magpie，支持多 API Key 池、动态模型目录、网关兼容、quota 中的 Fleet 负载摘要。

## 开发

仓库使用 npm workspaces 管理 packages/*：

~~~bash
npm run check:amd-tokenfactory
npm run test:amd-tokenfactory
~~~
