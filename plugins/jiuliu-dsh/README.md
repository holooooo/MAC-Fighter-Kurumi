# 韭留美 DSH token 插件

`@jiuliu/dsh-token-bridge` 是可安装的 DSH/Cordis Host 插件。它监听 DSH 的模型 usage 事件，把供应商实际报告的 **输出 token 增量** 发到本机韭留美服务。零 npm 运行依赖，无安装脚本，不读取会话日志。

## 安装

先让韭留美本地服务运行在 `127.0.0.1:8766`。从项目目录运行：

```sh
dsh plugin --profile desktop add "$PWD/plugins/jiuliu-dsh"
```

`dsh plugin --help` 已在本机安装的 DSH `0.2.1-rc.2` 上验证：`--profile` 指定 profile，剩余参数原样交给 pnpm。路径换成实际项目的绝对路径即可。

安装器读取本包 `dsh.bundle.patch`，将依赖名加入目标 profile 的 `dsh.profile.bundles`。本机这次安装后，运行中的 desktop Host 已实际自动挂载插件，CLI 收到了真实 provider usage。其他环境是否能立即应用取决于 Host 的 HMR 配置；若没有心跳，退出并重新打开 DeepSeek Harness，使 profile 重新挂载。该包没有浏览器代码，不依赖前端开发 watcher。仅刷新网页不会重新启动 Host。

插件装载后会发送 `tokens: 0` 的连接心跳；实际模型 usage 到达后，token 增量会在下一次每秒刷新时送出。韭留美 CLI 的 `tokens` 命令和桌宠读取同一服务的 `telemetry.dshTokens`。

## 数值含义

数据只来自 `usage.outputTokens`，不含输入、缓存 token，也不把命令次数、字符数、文字片段数量当作 token。

供应商给出流式累计 usage 时，插件计算每次累计量相对已发送量的正增量。同一请求的最终消息和流式 usage 会被合并去重。重试的新请求单独计数；已经生成但随后中断的输出，只要供应商实际报告了 usage，也会保留。

服务端 `tokens/s` 表示 **每个采样间隔内收到的供应商输出 token 增量 / 实际采样秒数**。供应商只在完成时返回 usage，则图表会在完成时出现一笔真实数量；无法据此恢复每秒实际生成曲线，插件不会估算或摊平。完全没有 usage 的生成不产生 token 数值；未知 usage 的活动请求会暂停零心跳，让服务按超时规则转为 stale。

## 本地接口与隐私

固定请求目标为 `http://127.0.0.1:8766/api/dsh-tokens`，只允许配置数值 `port`。请求体只有三个字段：

```json
{"eventId":"随机 UUID","tokens":42,"time":1792681200000}
```

`tokens` 是非负安全整数的输出增量，`time` 是本机聚合发送时的毫秒时间。`eventId` 不含 session、agent、attempt 或模型身份。没有提示词、回复文本、工具参数、工作目录或供应商凭证。重试复用同一个事件 ID，便于服务去重。

请求使用 Node 原生 HTTP，固定 loopback 地址，绕过代理环境变量，不跟随重定向。最多一个请求同时进行，超时一秒，网络失败/5xx/408/429 最多重试一次。队列有上限，过期与溢出会丢弃测量，不阻塞生成；它是实时遥测，不是持久化计费账本。

## 配置与卸载

插件 patch 的默认配置为 `port: 8766`。需要更换端口时，在 DSH 的 profile 配置中覆盖本插件条目的 `config.port`，并重启 Host。

```sh
dsh plugin --profile desktop remove @jiuliu/dsh-token-bridge
```

CLI 移除后重启 DSH。Cordis 卸载 effect 会注销监听器、停止计时器、清空内存队列并销毁进行中的 HTTP 请求。现有 DSH 版本使用 `ctx.effect` 的返回 disposer 完成资源释放，不依赖一个未被该版本发送的 `dispose` 事件。

完整开发契约见项目文档 `docs/dsh-plugin.md`。
