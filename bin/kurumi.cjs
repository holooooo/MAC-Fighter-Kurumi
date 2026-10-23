#!/usr/bin/env node
'use strict';
const [command = 'help', ...args] = process.argv.slice(2);
const output = value => console.log(JSON.stringify(value, null, 2));
const help = {usage:'node bin/kurumi.cjs <command> [args]', commands:{status:'查看与界面共享的实时状态',tokens:'读取DSH插件的真实输出token每秒与采样状态', buy:'<symbol> <quantity> [leverage]', sell:'<symbol> [quantity]', short:'<symbol> <quantity> [leverage] 卖出开空', cover:'<symbol> [quantity] 买入平空', candles:'<minute|hour|day> 三档真实OHLC与成交历史', borrow:'<amount>', repay:'[amount]',bankruptcy:'仅游戏：清空现金持仓债务并暂停投资，保留亏损记录',personality:'<JSON object>', automation:'<momentum|dip|dca|off>',add:'<JSON instrument>',samples:'<JSON sample array>',say:'<text>',expression:'<expression name>',export:'完整JSON快照'},note:'先启动 node server.cjs；默认 http://127.0.0.1:8766。KURUMI_URL 可指定本地端口。真实采样时间推进，不提供伪造行情tick。'};
if (command === 'help' || command === '--help') {output(help);process.exit(0);}
const number = value => {const n = Number(value);if(value === undefined || !Number.isFinite(n))throw new Error('需要有限数值');return n;};
(async () => {
  const url = new URL(process.env.KURUMI_URL || 'http://127.0.0.1:8766');
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('KURUMI_URL 必须为本地HTTP服务');
  let endpoint = '/api/action', body = {action: command};
  switch(command) {
    case 'tokens': case 'status': case 'export': endpoint='/api/state';body=null;break;
    case 'candles': if(!['minute','hour','day'].includes(args[0]))throw new Error('周期须为minute、hour或day');endpoint=`/api/state?timeframe=${args[0]}`;body=null;break;
    case 'buy': case 'short': body={action:command,symbol:args[0],quantity:number(args[1]),...(args[2]===undefined?{}:{leverage:number(args[2])})};break;
    case 'sell': case 'cover': body={action:command,symbol:args[0],...(args[1]===undefined?{}:{quantity:number(args[1])})};break;
    case 'borrow': body.amount=number(args[0]);break;
    case 'repay': if(args[0]!==undefined)body.amount=number(args[0]);break;
    case 'bankruptcy': break;
    case 'personality': body.personality=JSON.parse(args.join(' '));break;
    case 'automation': if(!['momentum','dip','dca','off'].includes(args[0]))throw new Error('策略须为momentum、dip、dca或off');body.automation={enabled:args[0]!=='off',...(args[0]==='off'?{}:{strategy:args[0]})};break;
    case 'add': body.instrument=JSON.parse(args.join(' '));break;
    case 'samples': endpoint='/api/samples';body={samples:JSON.parse(args.join(' '))};break;
    case 'say': body.text=args.join(' ');break;
    case 'expression': body.name=args[0];break;
    default: throw new Error('未知命令，运行 --help');
  }
  const response = await fetch(new URL(endpoint,url),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  const result = await response.json();
  if(!response.ok || result.ok===false)throw new Error(result.error || `HTTP ${response.status}`);
  output(command === 'tokens' ? {metric:result.telemetry?.dshTokens ?? {status:'unavailable',value:null}, instrument:result.game?.instruments?.find(i=>i.id==='DSH') ?? null} : result);
})().catch(error=>{output({ok:false,error:error.cause?.code==='ECONNREFUSED'?'桌宠服务未启动，请运行 node server.cjs':error.message});process.exitCode=1;});
