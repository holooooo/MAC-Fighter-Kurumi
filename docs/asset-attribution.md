# 素材与第三方许可

本项目是非官方、个人娱乐性质的桌宠与虚拟交易模拟；与《FX战士久留美》原作者、出版社、动画制作方不存在官方授权或合作声明。角色名称、形象及相关权利仍属于各自权利人。AI生成与付费生成不自动获得原作品知识产权授权。MIT仅适用于本项目原创代码与文档，不适用于角色美术。

## 发布包内美术

粉发白裙、酒红蝴蝶结与鞋的角色为用户选定ArtArch静态结果的派生动画。清单assets/kurumi-generated.json记录参考哈希与生成来源；15种动作由同一静态图的6个本地仿射动作及3条生成视频派生的9个动作组成，不是15条独立生成视频。runtime为APNG，GIF仅兼容导出。表情图片取自这些动画的本地帧。

历史调研使用过的漫画截图、转载表情包、角色资料室和旧SVG试片不纳入本公开源码与应用发行包；本地存在这些文件不代表再分发授权。原作官方参考：https://fxkurumi-info.com/ 。请勿将角色素材视为已取得商业再分发授权；任何商业用途或进一步公开传播需独立核对权利。权利人可通过GitHub issue联系要求移除。

## 交互参考

文字/图片气泡交互参考PC2005-cloud/dsh-pet（commit48007b64ac0bebb2e97ac88344aed62de8399dd4）的公开实现原则。没有复制其角色动画、提示词、视频、字体；其代码MIT不覆盖上游另行限制的素材。来源：https://github.com/PC2005-cloud/dsh-pet 。

## 运行库

Chart.js4.4.8、chartjs-chart-financial0.2.1、Luxon3.6.0、chartjs-adapter-luxon1.3.1随本项目原样保留MIT许可证；版本、来源、哈希见vendor/chart-dependencies.json。

macOS应用内嵌官方Node.js可执行文件；Node及其随附组件许可通过发行版LICENSE保存在应用Contents/Resources/runtime/LICENSE，发行压缩包还附THIRD-PARTY-NOTICES.md。应用与Widget由AppKit/WebKit/WidgetKit原生构建，本版仅本地ad-hoc签名、未公证。
