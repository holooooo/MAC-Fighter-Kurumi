# 久留美动画资产与打样记录

## 当前人设与运行时资产

用户已选定 ArtArch 图像节点 `A4vCOxNi9Wh_dGLJr7B8rb` 为唯一人设。粉发、双白夹、白裙、酒红蝴蝶结与鞋，以实际JPEG图像的身体比例为准；节点标题中的“二头身”是历史命名，不是重新拉伸身体或强制二头身的要求。早期文档称其为“未通过比例验收的草稿”已不适用于当前选择。原图实际896×1200 JPG，不是供应商输出的无损PNG；转存PNG不会恢复JPEG已丢失的细节。

`assets/kurumi-generated.json` version 3是当前资产清单，分别记录GIF兼容导出及APNG运行时的文件、字节数与SHA256，并保留人设来源、时长与帧数。当前共15种动作，运行时使用8-bit alpha APNG保留半透明边缘；GIF不支持这种半透明。统一画布336×452，海报为 `assets/kurumi-generated-idle.png`：

- 6个原图本地仿射变换：`idle`、`look`、`sway`、`press`、`dragging`、`landing`。这是原图局部播放/整体变换，不是新生成的逐帧角色表演。
- 9个生成视频本地剪辑、重定时动作：`wave`、`stretch`、`profit`、`buy`、`loss`、`liquidation`、`sell`、`blink`、`sleep`。它们来自下列3条完成的视频，不是9次或15次独立收费生成。

已完成的 Seedance 2.0 Mini 来源run（以manifest为准）：

- wave：`c1e25035-5a25-4fc0-b8ff-8ebf25277f4e`，用于挥手、伸展、庆祝、眨眼和休息派生动作。
- loss：`796d6605-2631-4c24-8d1f-833e758419ae`，用于亏损、爆仓和卖出派生动作。
- fomo：`e14e3fcc-d813-48a8-965a-e5c17c533e0a`，用于买入派生动作。

本地剪辑、抠像、变换与重定时不消耗生成积分。已重做背景去混合并验证深浅底边缘，APNG随原生应用重新构建；不宣称所有循环首尾无缝或物理拖动已验收。

2026-10-23另外获准提交“老实赚钱很枯燥吧”“亏损黑线”“捂嘴反胃”三个新节点。第一条run75306b4d-4ca5-4e4b-851e-72aefd6c8948返回insufficient customer quota、0产物，余额8492保持不变；按失败即停止约定，另外两条未提交。这三条没有计入当前15动作或本版Release，不会用仿射动作冒充已生成的托腮/干呕。

## 生成与费用历史

画布：<https://www.artarch.ai/canvas/project-files?projectId=4c7a8f42-9403-485f-8a4a-a7f80bf6ed8b&workflowId=b2bcf715-6fc9-4abb-8127-88c1be030d92&platform=studio>。当时安装的ArtArch CLI / skill经 `version` 和 `upgrade` 确认为v1.4.5；这是操作记录，不宣称始终为最新版本。

1. 原角色PNG作为身份参考；用户单独授权后运行一个 `nanobanana-2-lite` 单张节点，run `799c0a7e-c5cd-4705-b35b-d5f95240a257`，done且下载成功。余额8541→8540，实际1积分。该JPEG后来由用户选为当前人设，不再标记为拒绝草稿。
2. 历史首条SVG试片：节点 `AFDr5sb9lHijTIiyk7_ikI`，run `6d7be9db-4a4d-4ccf-aae0-6de30029eb16`，使用旧桌宠SVG本地渲染的无损PNG作唯一静态输入，不是当前选定JPEG。4秒、480p档、无声，实际560×752、24fps、97帧、4.041667秒；余额8540→8528，实际12积分。鞋型变化、首尾不对齐，已拒绝作为当前运行时资产。图片与该旧试片当时小计13积分，仅代表这一历史阶段。
3. 后续曾提交不受支持的3:4视频任务：未产出可用artifact，已退回12积分；不是已交付片段，也不能重复计入净花费。随后改用支持的9:16设置完成当前3条来源视频。
4. 当前3条新片依据先前余额记录共36积分；manifest记录 `source.credits=36`、`localEditingCredits=0`。这不是整个项目累计支出。跨历史阶段的实际净总额仍由Lead核对余额/退款记录后汇总，本文不自行推算最终账单。

## 历史预览与实现边界

旧SVG试片曾输出12fps、336×452透明APNG和HEVC Alpha MOV，原视频保留；预览位于 `output/kurumi-generated-video/pilot-review.html`，不接服务、不执行下单。AVFoundation抽帧记录 `output/kurumi-generated-video/native-alpha-check.json` 与WKWebView play/seek/canvas记录 `output/kurumi-generated-video/webkit-alpha-check.json`，仅证明当时透明格式可在对应引擎播放，不证明当前GIF包、循环质量或正式事件全部验收。旧SVG `assets/jiuliu-chibi.svg` 与此试片均为历史资产，不应再描述成当前生产角色。

资产链概念参考 PC2005-cloud/dsh-pet，阅读commit `48007b64ac0bebb2e97ac88344aed62de8399dd4`：外部生成视频、抠像、归一化和透明格式转码，不是ArtArch一键生成器。上游代码MIT不涵盖README另行限制商用的动画、提示词与源视频；没有复制其角色动画、原文提示词或其他受限素材。角色与原作相关授权仍须发布前独立核对。
