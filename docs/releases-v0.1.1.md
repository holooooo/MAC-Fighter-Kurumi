# 韭留美v0.1.1 · Apple Silicon预览版

macOS桌面透明桌宠＋真实本机指标驱动的虚拟交易。建议macOS14+、Apple Silicon；仅提供arm64安装包。

## 本版包含

- AppKit透明置顶桌宠、独立交易面板、CLI和Agent技能；离线界面与内嵌官方Node24运行时，无需用户安装Node。
- CPU/内存/负载等本机采样，分钟/小时/日OHLC与同步视窗；虚拟多空/杠杆/贷款/自主策略/手动破产与持久交易日记。
- 指定粉发白裙人设的15种现有动作，重做绿幕去混合，APNG保留半透明，GIF仅兼容导出。表情图片改用已有生成动画帧，不打包调研漫画截图。
- 真实界面截图README、具体安装/升级/卸载/权限/端口说明；推送v标签自动构建并发布ZIP和SHA256SUMS的GitHub Actions。

## 安装

从本页下载JiuliuPet-v0.1.1-macos-arm64.zip与SHA256SUMS，放同一目录，运行`shasum -a 256 -c SHA256SUMS`，确认OK后解压，将韭留美.app拖到「应用程序」。校验和仅证明下载完整性。

当前为ad-hoc签名，未Developer ID签名或Apple公证。只在核对来源并信任应用后，通过Finder「打开」或系统设置「隐私与安全性 → 仍要打开」处理首次启动提示；不要关闭全局Gatekeeper。详见[安装说明](https://github.com/holooooo/FX-Fighter-Kurumi/blob/v0.1.1/docs/installation.md)。

## 验证与限制

本地209项Node测试及纯Swift回归通过，最终原生双窗口smoke通过；正式线上Actions结论以本Release关联run为准。Widget扩展已编译嵌入，但图库添加/实际渲染、物理拖动全链路、长时间资源占用未完成验收。默认端口8766需无其他非本应用服务冲突。

新请求的“老实赚钱很枯燥吧”“亏损黑线”“捂嘴反胃”三条不在本版：首条生成平台返回insufficient customer quota、无产物、净消耗0，已按约定停止另外两条，没有偷偷重试。

账户保存在~/.kurumi/live-state.json，全部虚拟货币，不接真实券商，不上传本地账本。角色为非官方二创，不声明原作授权；MIT仅覆盖本项目原创代码，角色美术及第三方组件遵循各自权利。

## 修复

v0.1.0线上构建因测试依赖未发行历史素材而失败，未产生Release。v0.1.1将安全响应测试锚定到实际发行的PNG角色与表情资产，并保留PNG禁止嵌入的更严格CSP。干净源码导出209测试与纯Swift回归均通过；旧标签不移动。
