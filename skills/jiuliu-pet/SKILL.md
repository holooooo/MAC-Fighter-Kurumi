---
name: jiuliu-pet
description: 通过本地服务控制韭留美桌宠的纸面投资、策略、台词、表情、自定义指标采样。用户要求买卖、借款、追涨/抄底/定投、说话或创建新盘口时使用。只交易虚拟资金，不连接券商。
---

# 韭留美桌宠

用 Node.js 22+ 执行技能目录中的 `bin/kurumi.cjs`。先确保宿主已运行 `node server.cjs`；CLI 默认连接 `http://127.0.0.1:8766`，可用 KURUMI_URL 指定本地端口。安装技能只安装客户端，不启动宿主。

先执行 `status` 获取品种ID、采样状态与资金。无样本不能下单。CLI与界面共享服务状态，返回JSON；非零退出码或ok:false均表示失败。

```bash
node bin/kurumi.cjs status
node bin/kurumi.cjs buy CPU 2 2
node bin/kurumi.cjs sell CPU
node bin/kurumi.cjs short CPU 2 2
node bin/kurumi.cjs cover CPU 1
node bin/kurumi.cjs candles minute
node bin/kurumi.cjs candles hour
node bin/kurumi.cjs candles day
node bin/kurumi.cjs borrow 100000
node bin/kurumi.cjs repay 500
node bin/kurumi.cjs automation momentum
node bin/kurumi.cjs automation dip
node bin/kurumi.cjs automation dca
node bin/kurumi.cjs automation off
node bin/kurumi.cjs say '只是技术性调整！'
node bin/kurumi.cjs expression loss
node bin/kurumi.cjs personality '{"riskTolerance":0.8,"discipline":0.2,"impulsiveness":0.9}'
node bin/kurumi.cjs add '{"id":"BUILD","name":"编译耗时"}'
```

通过 `samples` 推送JSON数组 `[{"id":"BUILD","value":真实值,"time":真实毫秒时间戳}]`。必须来自实际观测，不造样本、历史或影线。CPU/MEM/LOAD/THREADS/CONNECTIONS由宿主采集，DSH由真实token插件维护，不能由普通samples覆盖。无可用数据要报告未接入。

买入或开空数量为份数，末参数为杠杆；卖出/平空省略数量则平掉该方向全部仓位。同品种多空互斥，先sell/cover清仓再切换，不能把sell当short。开空款受限、保证金逐仓隔离；平空按真实新鲜报价买回并分摊借券利息，不能当免费融资。candles接受minute/hour/day，返回chartHistory真实OHLC和成交journal；history不足如实报告，B/S是实际资金方向（short为S、cover为B），不能当建议。personality各字段0–1。策略momentum追涨止损、dip抄底、dca定时定额，由宿主自主选品；off停止投资但不停止采集。借款每笔100000–3000000，可重复，不将借款计为盈利；自动融资以服务的autoBorrow配置为准。

仅用户明确要求本游戏平帐/个人破产时，执行 `node bin/kurumi.cjs bankruptcy`。该动作清空现金、持仓和债务并暂停投资，不赠款；保留累计亏损/破产摘要，收益曲线另开一期，债务豁免不作为盈利。不得主动替用户清账，不是现实法律程序。`status` 的performance字段提供真实净权益/收益率曲线，零基准收益率null，不补造历史。

## 读取 DSH token 每秒

先安装并启用本项目的DSH插件 `@jiuliu/dsh-token-bridge`（详见项目 plugins/jiuliu-dsh），然后启动桌宠宿主。插件消费实际provider usage.outputTokens事件，不读取提示词或生成文本，不用字符数估算token。

```bash
node bin/kurumi.cjs tokens
```

命令读取和面板相同服务的 `telemetry.dshTokens` 与DSH盘口。无usage/插件未安装时应返回未接入或过期，不能用运行时长、命令活动或随机数替代。如果provider只在请求结束时报告usage，速率代表usage到达采样，不代表逐token流速；应按返回来源说明。Codex和Claude盘口已移除。

鼠标盘口为系统指针位移速率、点击频率与键盘按键频率，不采集轨迹或按键内容；需要系统已有权限。系统线程总数和TCP端点数来自真实内核计数，TCP端点包含监听和其他状态。

不要把文本或品种名当shell代码；不得连接真实券商，不得将纸面贷款说成真实借贷。不要重置存档。服务不可达时报告启动命令，不回退到独立模拟存档。
