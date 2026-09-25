/**
 * 降级/重试逻辑单测：node --import tsx scripts/failover-test.mjs
 *
 * 锁住 5eda350 引入的分类与决策逻辑（src/bus.ts 顶部导出的纯函数）。重点是
 * **软失败**那条：agnesd 把上游错误写进正文再正常 end_turn，不特判就会把
 * 失败回合当成成功返回——这类 bug 静默且难复现，必须有回归。
 *
 * 样例全部取自实测日志 ~/.agnes/state/logs/server/**-agnesd.log。
 */
import {
  GENERIC_MODEL_FALLBACKS,
  RATE_LIMIT_BACKOFF_SEC,
  backoffSec,
  isAuthOrQuotaFailure,
  isRateLimited,
  nextFallback,
  rateLimitExhaustedMsg,
  rateLimitMaxAttempts,
  softFailureOf,
} from '../src/bus.ts';

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

console.log('=== 软失败检测（最容易漏、危害最大的一条）===');
// 实测正文：工具调用成功后才写这句，且 stop=end_turn
const softRate = `Ran into this error: Rate limit exceeded: You've reached the API rate limit
for free users. Upgrade to a Token Plan to unlock higher limits and continue using
the API without interruption. (request id: 202609250358…)

Please retry if you think this is a transient or recoverable error.`;
check('识别速率限制软失败', typeof softFailureOf(softRate), 'string');
check('软失败同时被判定为速率限制', isRateLimited(softRate), true);
check('软失败同时属于认证/配额类', isAuthOrQuotaFailure(softRate), true);

const softAuth = "Ran into this error: Authentication error: Authentication failed for https://apihub.agnes-ai.cn/v1/chat/completions. Status: 401 Unauthorized.";
check('识别 401 软失败', typeof softFailureOf(softAuth), 'string');
check('401 不误判为速率限制', isRateLimited(softAuth), false);

// 正常回复绝不能被误判（误判会导致无谓重试/降级）
check('正常回复不算软失败', softFailureOf('你好，agentbd-p2-ok'), undefined);
check('工具输出不算软失败', softFailureOf('agentbd-p2-ok\n[终端退出 code=0]'), undefined);
check('含 "error" 字样的正常回复不算软失败', softFailureOf('这里有个 error handling 的例子'), undefined);
check('正常回复不触发降级', isAuthOrQuotaFailure('你好'), false);
check('空正文不算软失败', softFailureOf(''), undefined);

console.log('\n=== 失败分类 ===');
check('401 Invalid token 属配额类', isAuthOrQuotaFailure('Invalid token'), true);
check('403 预扣不足属配额类', isAuthOrQuotaFailure('Failed to pre-consume quota, remaining: $0.001942, required: $0.010800'), true);
check('insufficient_user_quota 属配额类', isAuthOrQuotaFailure('{"code":"insufficient_user_quota"}'), true);
check('ACP -32000 原文属配额类', isAuthOrQuotaFailure('agnes 运行失败: Authentication required'), true);
check('工具执行失败不属配额类', isAuthOrQuotaFailure('终端退出 code=1'), false);
check('ENOENT 不属配额类', isAuthOrQuotaFailure('spawn ENOENT /no/such/bin'), false);
check('预算超限不属配额类（不该被自动降级）', isAuthOrQuotaFailure('预算超限，已拦截本次调用'), false);
check('裸 400 数字不算（避免误伤行号/耗时）', isAuthOrQuotaFailure('took 400ms'), false);

console.log('\n=== 退避策略 ===');
check('第 1 档 8s', backoffSec(1), 8);
check('第 2 档 20s', backoffSec(2), 20);
check('第 3 档 45s', backoffSec(3), 45);
check('超出档位封顶 60s', backoffSec(99), 60);
check('第 0 档不越界', backoffSec(0), 8);
check('负数不越界', backoffSec(-5), 8);
check('默认只重试 1 次', rateLimitMaxAttempts({}), 2);
check('AGENTBD_RATE_RETRIES=0 不重试', rateLimitMaxAttempts({ AGENTBD_RATE_RETRIES: '0' }), 1);
check('AGENTBD_RATE_RETRIES=5 → 6 次', rateLimitMaxAttempts({ AGENTBD_RATE_RETRIES: '5' }), 6);
check('退避档位单调不减', RATE_LIMIT_BACKOFF_SEC.every((v, i, a) => i === 0 || a[i - 1] <= v), true);

console.log('\n=== 降级模型链 ===');
check('agnes 首选 flash', nextFallback('agnes', new Set()), 'agnes-2.0-flash');
check('已试过则取下一档', nextFallback('agnes', new Set(['agnes-2.0-flash'])), 'agnes-2.5-flash');
check('全试完返回 null（该抛原始错误）', nextFallback('agnes', new Set(['agnes-2.0-flash', 'agnes-2.5-flash'])), null);
check('claude 无降级链', nextFallback('claude', new Set()), null);
check('未知引擎无降级链', nextFallback('nope', new Set()), null);
check('agnes 链不含 pro（就是它要预扣）', GENERIC_MODEL_FALLBACKS.agnes.includes('agnes-2.5-pro'), false);

console.log('\n=== 耗尽提示可操作性 ===');
const msg = rateLimitExhaustedMsg('agnes', 3, 'Rate limit exceeded: ...\nsecond line');
check('点名引擎', msg.includes('agnes'), true);
check('说明已重试次数', msg.includes('已重试 3 次'), true);
check('澄清不是余额问题', msg.includes('不是余额问题'), true);
check('给出换引擎出路', msg.includes('换引擎'), true);
check('给出调参出路', msg.includes('AGENTBD_RATE_RETRIES'), true);
check('附原始错误首行', msg.includes('Rate limit exceeded'), true);
check('不泄露原始错误后续行', msg.includes('second line'), false);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
