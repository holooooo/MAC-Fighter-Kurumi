# 安装韭留美

## 系统要求

本发行版支持Apple Silicon（M1及更新）Mac，建议macOS14或更新；不提供Intel/Windows/Linux安装包。下载版已内嵌官方Node.js，无需安装Node、npm或Python。源码构建的最低宿主配置与Widget要求可能不同，以发行版测试范围为准。

## 下载、校验、安装

1. 打开[GitHub Releases](https://github.com/holooooo/FX-Fighter-Kurumi/releases/latest)，下载该版本的JiuliuPet-v0.1.0-macos-arm64.zip与SHA256SUMS。不要下载Source code ZIP当成应用安装包。
2. 把ZIP与SHA256SUMS放在同一文件夹。在终端进入该目录，例如`cd ~/Downloads`，执行`shasum -a 256 -c SHA256SUMS`。应看到ZIP名称及`OK`。失败则停止安装，重新下载；校验只证明与同一发布页的文件一致，不等于Apple公证或可信发行者身份。
3. 双击ZIP解压，将韭留美.app拖进Finder的「应用程序」。压缩包附带README、安装说明及许可文件，不必把整个源码目录放入应用程序。
4. 从「应用程序」打开韭留美。桌宠与交易面板共用本地服务。菜单栏可「打开面板」「显示／隐藏桌宠」「退出韭留美」。关闭面板不等于退出桌宠。

## 首次打开与系统提示

当前为本地ad-hoc签名，未使用Apple Developer ID签名，未公证。macOS可能显示“无法验证开发者”。先核对GitHub仓库、版本、校验和与源码，只在信任此来源时继续。

可在Finder按住Control点击应用并选「打开」；若系统仍阻止，先尝试打开一次，再进入「系统设置 → 隐私与安全性」，在本应用对应的安全提示中选择「仍要打开」，按系统提示确认。不同macOS版本文案可能不同。不要全局关闭Gatekeeper，不要复制来源不明的解除限制命令。如果提示“已损坏”，先重新下载校验；仍不确定时从源码构建，而不是忽略警告。

## 数据与权限

账户与最近500笔有限交易日记保存在`~/.kurumi/live-state.json`，服务定期和退出时保存。升级前建议复制该文件备份；不要在服务运行期间手工编辑。所有资金为虚拟游戏币，不连接券商。

鼠标/键盘指标需要系统已允许的输入监控能力。应用只累计次数和屏幕点位移，不保存输入文字或轨迹；没有权限时显示不可用。若想启用，可在「系统设置 → 隐私与安全性 → 输入监控」核对韭留美权限，之后退出并重开。应用不保证主动出现授权弹窗。不需要这些指标也可使用CPU、内存、负载盘口。

DSH token统计是可选插件功能，见[dsh-plugin.md](dsh-plugin.md)。小组件已随包编译，但系统图库添加与实际显示尚未完成手工验收，不作为本版安装成功条件。

## 端口冲突与无法打开面板

服务固定监听`127.0.0.1:8766`。浏览器可访问`http://127.0.0.1:8766/pet.html`。若应用提示端口占用，在终端执行`lsof -nP -iTCP:8766 -sTCP:LISTEN`查看占用者。只停止你确认用途且允许关闭的程序；不要按PID盲目结束进程。若已有韭留美健康服务，应用会复用它且退出时不关闭它。

应用服务日志在`~/Library/Logs/JiuliuPet/service.log`。启动失败时可把去除个人信息后的错误和系统版本提交GitHub issue；不要上传完整用户目录、认证配置或账户存档。

## 升级、退出与卸载

升级前从菜单「退出韭留美」，备份本地存档，再用新版替换「应用程序」中的旧app。替换app不应删除`~/.kurumi`数据。重新打开后检查账户与日记。若旧服务由别的终端独立启动，先在对应终端正常停止它，再启动新版，避免继续复用旧服务。

卸载时先退出，把app移到废纸篓即可。存档与日志默认保留；需要彻底删除时先确认备份，再由Finder手动处理`~/.kurumi`和`~/Library/Logs/JiuliuPet`。这些是游戏账户记录，不会影响真实金融账户。

## 从源码构建

安装Xcode Command Line Tools与Swift6工具链，使用Node22+。在仓库目录执行`node server.cjs`可运行浏览器版。原生构建执行`bash scripts/build-macos.sh`；如果本机Node依赖Homebrew动态库，需通过绝对路径KURUMI_NODE_PATH指定官方独立Node。Widget扩展执行`bash scripts/build-widget.sh`。发布打包与完整校验见[维护者指南](release-maintainer.md)。
