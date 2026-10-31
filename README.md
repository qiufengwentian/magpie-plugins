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

## 发布

发布使用 npm Trusted Publishing（OIDC），工作流为 [.github/workflows/release.yml](.github/workflows/release.yml)。

npm 要求包已存在才能配置 Trusted Publisher，因此首次发布新包需要先手动发布一次，再配置 GitHub 仓库；之后推送 tag 即可由 GitHub Actions 自动发布：

~~~bash
npm login
npm publish --workspace magpie-plugin-amd-tokenfactory

# 需要 npm CLI 11.15+
npm trust github magpie-plugin-amd-tokenfactory \
  --file release.yml \
  --repo qiufengwentian/magpie-plugins \
  --allow-publish
~~~

后续发布先把 `packages/<name>/package.json` 的 version 改为新版本，再推送格式为 `<npm 包名>-v<semver>` 的 tag。工作流会校验 tag 与 version 一致、运行全仓库测试、通过 OIDC 发布到 npm，并创建 GitHub Release：

~~~bash
git tag magpie-plugin-amd-tokenfactory-v0.1.1
git push origin magpie-plugin-amd-tokenfactory-v0.1.1
~~~

Trusted Publisher 配置中的 workflow 文件名必须是 `release.yml`，仓库名与上面一致；不需要配置 `NPM_TOKEN`。也可在 npm 包的 Trusted Publishing 设置页完成配置。
