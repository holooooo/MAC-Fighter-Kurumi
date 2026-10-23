# WidgetKit 账户小组件

已实现真正的WidgetKit扩展，独立于透明桌宠窗口，支持小号/中号布局。最低macOS14，包含它的宿主仍可独立运行在macOS13。开发构建为本机架构、ad-hoc签名，未公证。

## 构建与打开

```bash
bash scripts/build-macos.sh
bash scripts/build-widget.sh
open output/韭留美.app
```

第二条命令将扩展嵌入宿主Contents/PlugIns，再从内到外签名。更新宿主后应再次构建小组件。仅需CLT中的Swift编译器和SDK，无需xcodebuild；当前机器已实际编译通过。

## 数据和刷新

小组件只读GET http://127.0.0.1:8766/api/widget-state，显示虚拟账户权益、投资策略、CPU和内存采样，以及更新时间。网络请求2秒超时，不跟随重定向，不使用代理、cookie和缓存。接口不返回全部历史、设备身份或终端内容。

Timeline请求15分钟后更新，但刷新时间由系统调度，并非实时监控。预先排入采样到期条目（采样时间+60.001秒），即使尚未再次联网，也可切换为采样过期，CPU/MEM不再当作新读数；实际显示切换仍由WidgetKit执行。持仓估值是否过期由服务的独立equityStale字段表示，不能用新鲜CPU采样代替。服务不可达明确提示服务未运行，不能因此把账户写成0。点击小组件通过jiuliupet://panel打开宿主面板。

## 验收状态

已实际验证Swift编译、扩展Info.plist、扩展签名和宿主deep/strict签名。启动包含扩展的宿主后，`pluginkit -m -i local.jiuliu.pet.widget`已输出该扩展版本0.1.0，说明系统能发现它。没有查询个人签名身份或调用私钥。

尚未完成系统图库搜索、添加后实际渲染的视觉验收，因此不能宣称已经显示在桌面。当前辅助功能接口不能定位背景系统图库承载进程；未使用私有偏好写入或重启系统进程绕过。限定扩展ID的chronod日志显示已发现扩展，随后出现descriptor purge与SQLite Code19 FOREIGN KEY constraint failed；未见该扩展进程启动、明确签名拒绝或sandbox deny，因此根因尚未确定。

可在桌面右键“编辑小组件”后搜索“韭留美账户”，选择尺寸添加。扩展被系统发现不等于图库已显示，需继续图库验收与按需加载诊断。
