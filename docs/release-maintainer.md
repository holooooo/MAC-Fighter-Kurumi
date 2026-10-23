# macOS Release 维护说明

## 产物与边界

发布流程为 `.github/workflows/release.yml`。推送 `v*` 标签时自动运行；Actions 的手动运行必须填写**已经存在的标签**，不创建标签、不默认发布分支 HEAD。允许 `v0.1.0`、`v0.1.1-rc.1` 这类名称；带连字符的标签发布为 prerelease。标签必须包含本流程及相关脚本。

最终 GitHub Release 附件只有：

- `JiuliuPet-v版本-macos-arm64.zip`：根目录包含 `韭留美.app`、当前 README、独立INSTALL.md，以及仓库中实际存在的LICENSE/NOTICE/THIRD-PARTY-NOTICES文件。不会打包整个仓库或output目录。
- `SHA256SUMS`：只列此次 ZIP，供下载完整性校验；不构成发行者身份或 Apple 公证证明。

应用包含原生宿主、WidgetKit 扩展、离线前端资源、已提交 APNG/GIF 和独立 Node.js 运行时。CI 不调用 ArtArch、不生成素材、不需要图像服务密钥。仅支持 **Apple Silicon arm64**；完整应用/Widget 以 macOS 14+ 为使用基线，不提供 Intel 或 Universal 产物。应用、Node 和扩展只有 ad-hoc 签名，**未使用 Developer ID、未 notarize**。Widget 构建和签名通过不等于完成图库添加、实际显示或物理输入验收。

## 发布前检查

确认版权与分发许可，尤其是人物参考、生成素材、图表依赖和 Node。根目录没有 LICENSE 时，不能据此宣称本项目采用某个开源许可证。打包器只复制实际文件，不生成许可声明。四个当前图表库的许可证应随应用 vendor 资源保留；Node 官方发行版的 LICENSE 必须存在于应用 `Contents/Resources/runtime/LICENSE`，或通过 `KURUMI_NODE_LICENSE_PATH` 提供。

先完成本地 Node 回归、纯 Swift 回归和实际应用验收，再由有仓库权限的维护者创建/推送版本标签。版本号采用 `vMAJOR.MINOR.PATCH[-预发布标识]`。不要把本地账户、token、`.env`、生成服务凭据、native `.build` 或 output 临时文件提交进仓库。工作流自身不创建仓库、不 push、不创建标签。

## Actions 流程

1. `build` 使用 `macos-15` 标准 runner，并强制 `uname -m = arm64`。截至 2026-10-23，GitHub 官方 runner 表将 `macos-15` 列为 arm64、`macos-15-intel` 列为 Intel；不要根据旧印象替换标签。见 [GitHub runner 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 和 [runner-images 官方表](https://github.com/actions/runner-images)。运行时架构检查可在标签映射变化时明确失败，而不是发布误标 ZIP。
2. 按完整 ref 检出既有标签并核对 commit，checkout 不保留凭据。官方 setup-node 安装 Node **24 主版本**的最新可用 arm64 发行版（不是固定补丁版），记录版本，检查实际架构，并取发行包自带 LICENSE。每个 Action 固定完整 SHA；升级时从对应 `actions/*` 官方仓库核对 SHA 与版本，不用浮动 Action 标签。
3. 执行 `node --test tests/*.test.cjs tests/*.test.mjs` 和 `bash scripts/test-native.sh`，不启动 GUI、不使用必须桌面授权的原生检查。测试项数量以本次真实输出为准。
4. 顺序执行 `build-macos.sh`、`build-widget.sh`、`package-release.sh`。打包阶段验证宿主、Node、Widget 都是单一 arm64 且只依赖系统动态库，校验签名和关键资源；版本更新与重签只发生在临时副本，不修改原 output 应用。正式 ZIP 生成前检查归档路径、必要成员和 CRC。
5. 上传此次准确的 ZIP 与 SHA256SUMS，保留 14 天。`publish` 使用独立 Ubuntu job，仅此 job 授予 `contents: write`；不检出或运行仓库代码。下载本 run 产物、验证严格文件清单与 SHA256 后，以`gh release create --verify-tag --notes-file`发布；优先使用docs/releases-v版本.md的具体说明，否则生成最小边界提示。RELEASE_NOTES.md只在Actions artifact内传递，不作为公开附件。没有长期 PAT、开发者证书或其他发布 secret。

手动补发：在默认分支可见该 workflow 后，Actions → Release Apple Silicon macOS app → Run workflow，输入既有版本标签。代码仍检出该标签，而不是所选分支最新代码。不要向输入传分支名、commit 或 shell 片段。输入始终通过环境变量传入、使用正则校验和带引号的参数传递，不插值到 shell 代码。

同一标签串行处理，不取消正在发布的任务。已经存在的 GitHub Release 会让 create 失败；不使用 `--clobber`、不默默替换附件。若 build 成功而 publish 失败，优先定位权限/已存在 release 等原因并只重跑失败 job。若需要修复已发布版本，建议新版本标签；是否删除旧 draft/release 应由维护者明确决定。本流程不会自动删除它。

## 本地打包

在 Apple Silicon 原生 shell 中，先使用仅依赖系统动态库的官方 Node 24 arm64 发行版。Homebrew 动态链接 Node 不适合直接分发。明确设置 `KURUMI_NODE_PATH` 指向官方二进制、`KURUMI_NODE_LICENSE_PATH` 指向该发行版原始 LICENSE；已有 LICENSE 随应用保存时可不设后一项。依次执行：

```bash
node --test tests/*.test.cjs tests/*.test.mjs
bash scripts/test-native.sh
bash scripts/build-macos.sh
bash scripts/build-widget.sh
bash scripts/package-release.sh v0.1.0
(cd dist && shasum -a 256 -c SHA256SUMS)
```

本地脚本不下载 Node、不构建宿主、不请求系统权限、不碰账户存档、不打开应用、不上传附件。它只读取已构建的 `output/韭留美.app` 并写 `dist/` 的临时 staging 与最终两个文件，结束时清理自己的 staging。若目标 ZIP 或 `dist/SHA256SUMS` 已存在，直接失败，维护者先明确检查/移动旧文件再重跑；不清空 dist，不删除已有发布物。其余版本 ZIP 即便仍在 dist，也不会被加入此次 checksum 或工作流附件。

## 下载端核验与首次打开

下载同一个 Release 的 ZIP 和 SHA256SUMS，在二者所在目录运行 `shasum -a 256 -c SHA256SUMS`。解压后把 `韭留美.app` 放进 Applications，再按 README 的首次启动说明操作。下载自网络的 ad-hoc 应用可能被 Gatekeeper 阻止；仅在核实来源和校验和、信任此次构建后，按 macOS 系统设置 → 隐私与安全性提供的“仍要打开”等系统入口处理。不要要求用户关闭全局 Gatekeeper，不把 SHA256 当作公证，不承诺每个 macOS 版本都能直接双击运行。小组件仍需用户在系统图库手动添加，相关渲染边界见 `docs/widget.md`。

## 验证记录与失败处理

必须区分 shell/YAML 静态检查、本地现有应用打包、CI 实际构建、GitHub Release 发布，以及下载后真实安装验证。没有 Actions run 或 Release URL 时，不能声称线上发布已成功；工作区没有 Git 元数据时，提交、远端和标签也需由仓库负责人另行建立。当前指南不证明任何一轮线上发布已经执行。

维护时可执行 `bash -n scripts/package-release.sh`；使用 actionlint（若已安装）检查 workflow。发布前还应验证错误参数被拒绝、ZIP 不含源目录/用户数据、所有必要运行时文件和依赖通知都在归档内、SHA256 校验通过，并对最终解压应用复核 codesign。不要为测试失败伪造空运行时或跳过 arm64/签名校验。
