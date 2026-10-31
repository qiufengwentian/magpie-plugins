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

发布按包名和版本打 tag。推送 tag 后，[release.yml](.github/workflows/release.yml) 会先运行所有包的测试，再发布对应 workspace 到 npm，并把 `npm pack` 生成的 tarball 上传到 GitHub Releases。

~~~bash
# 先把 packages/<name>/package.json 的 version 改成要发布的版本
git tag magpie-plugin-amd-tokenfactory-v0.1.0
git push origin magpie-plugin-amd-tokenfactory-v0.1.0
~~~

标签格式固定为 `<npm 包名>-v<semver>`，且版本必须与对应 package.json 的 `version` 一致。发布前需要在 GitHub 仓库的 Settings → Secrets and variables → Actions 中配置 `NPM_TOKEN`（npm Automation token）；如果包名带 scope，工作流会自动追加 `--access public`。重复运行发布工作流时，已发布的 npm 版本会被跳过，已有 Release 则更新 tarball。
