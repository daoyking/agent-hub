/**
 * 面板渲染回归夹具：用 jsdom 载入**真实 ui.html**，桥接**真实 SSE**，
 * 驱动夹具引擎（scripts/fake-acp-agent.mjs）跑一轮真回合
 * （审批挂起 → 点击放行 → plan/terminal/diff 全事件），最后断言渲染后的 DOM。
 *
 * 前置：
 *   1. 注册夹具引擎（一次性）：~/.agentbd/engines.json
 *      [{ "id":"fake", "command":"<node 绝对路径>",
 *         "args":["<repo>/scripts/fake-acp-agent.mjs"], "channel":"acp" }]
 *   2. 起面板：agentbd serve --port 7801（端口可用 AGENTBD_PANEL 覆盖）
 *   3. npm i -D jsdom（devDependency）
 *
 * 跑：node scripts/ui-verify.mjs
 * 通过标准：末尾断言表 17/17 + 页面 JS 零错误；
 * 渲染后的 DOM 快照写到 /tmp/ui-rendered.html（可直接浏览器打开目测）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.env.AGENTBD_PANEL ?? 'http://127.0.0.1:7801';
const html = await readFile('/Users/jindy/Projects/agent-hub/src/ui.html', 'utf8');

const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => pageErrors.push('jsdomError: ' + (e.message ?? e)));
vc.on('error', (...a) => pageErrors.push('console.error: ' + a.join(' ')));

let sseStub = null;
class EventSourceStub {
  constructor(url) {
    this.url = url;
    sseStub = this;
  }
  close() {}
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  virtualConsole: vc,
  url: `${BASE}/`,
  beforeParse(win) {
    win.EventSource = EventSourceStub;
    win.fetch = (u, o) => fetch(new URL(typeof u === 'string' ? u : u.url ?? u, BASE), o);
  },
});
const { document } = dom.window;
const text = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();

// —— 桥接真实 SSE：读 /events 流，逐条喂给页面 onmessage ——
const events = [];
const waiters = [];
function notifyWaiters(ev) {
  events.push(ev);
  for (const w of [...waiters]) if (w.test(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
}
async function bridgeSse() {
  const t0 = Date.now();
  while (!sseStub) {
    if (Date.now() - t0 > 4000) {
      console.log('!! 页面未创建 EventSource（sseStub 为空）');
      console.log('pageErrors:', pageErrors.join(' | ') || '(无)');
      throw new Error('EventSource stub 未被调用——页面脚本可能提前抛错');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log('SSE stub 已挂载:', sseStub.url);
  const res = await fetch(`${BASE}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6));
      notifyWaiters(payload);
      sseStub.onmessage?.({ data: line.slice(6) });
    }
  }
}
const waitFor = (test, label, ms = 25000) =>
  new Promise((resolve, reject) => {
    const hit = events.find(test);
    if (hit) return resolve(hit);
    const t = setTimeout(() => {
      console.log(`\n!! 超时等待: ${label}`);
      console.log('已收事件:', events.map((p) => p.k + (p.ev ? ':' + p.ev.k : '')).join(' → '));
      console.log('页面错误:', pageErrors.join(' | ') || '(无)');
      reject(new Error(`超时等待: ${label}`));
    }, ms);
    waiters.push({
      test,
      resolve: (e) => { clearTimeout(t); resolve(e); },
    });
  });

// 兜底：无论如何 30s 内退出，避免挂死
setTimeout(() => {
  console.log('\n!! 全局超时兜底触发');
  console.log('pageErrors:', pageErrors.join(' | ') || '(无)');
  console.log('events:', events.map((p) => p.k).join(','));
  process.exit(1);
}, 30000).unref?.();

bridgeSse().catch((e) => console.log('SSE 桥接结束:', e.message));
await new Promise((r) => setTimeout(r, 800)); // 让页面 refresh() 落地 + SSE 连上

console.log('=== 面板初始状态 ===');
console.log('引擎下拉:', [...document.querySelectorAll('#engine option')].map((o) => o.value).join(', '));
console.log('就绪标记 #ready:', text('#ready') || '(空)');

// —— 跑真实回合（guard：terminal/create 会挂起审批）——
await fetch(`${BASE}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ engine: 'fake', prompt: 'UI 卡面目测回合', approval: 'guard' }),
});

const appr = await waitFor((p) => p.k === 'approval.request', '审批请求');
await new Promise((r) => setTimeout(r, 150));
console.log('\n=== 审批卡片（DOM 实测）===');
console.log('存在 .appr:', !!document.querySelector('.appr'));
console.log('文本:', text('.appr'));
console.log('按钮数:', document.querySelectorAll('.appr button').length);
const apprRendered = !!document.querySelector('.appr'); // 点击后会被 decided 移除，先取快照

// 点“允许”——走页面自己的 fetch('/api/approve')
document.querySelector('.appr .allow').click();

const done = await waitFor((p) => p.k === 'ask.done', '回合结束');
await new Promise((r) => setTimeout(r, 200));

console.log('\n=== 事件序列（真实 SSE）===');
console.log(
  events
    .filter((p) => p.k === 'ask.event')
    .map((p) => p.ev.k + (p.ev.k === 'terminal.exit' ? `(code=${p.ev.exitCode})` : ''))
    .join(' → '),
);
console.log('stopReason:', done.result.stopReason);

console.log('\n=== 终端卡片（DOM 实测）===');
console.log('卡片数 .term:', document.querySelectorAll('.term').length);
console.log('head:', text('.term .term-head'));
console.log('out:', text('.term .term-out'));
console.log('exit:', text('.term .term-exit'));

console.log('\n=== plan 时间线（DOM 实测）===');
console.log('#planbox 存在:', !!document.getElementById('planbox'));
console.log('done 行:', document.querySelectorAll('#planbox .done').length,
  '| doing 行:', document.querySelectorAll('#planbox .doing').length);
console.log('内容:', text('#planbox'));

console.log('\n=== diff 卡片（DOM 实测）===');
const diff = document.querySelector('.diff');
console.log('卡片数 .diff:', document.querySelectorAll('.diff').length);
console.log('head:', text('.diff .diff-head'));
console.log('删除行:', document.querySelectorAll('.diff .del').length,
  '| 新增行:', document.querySelectorAll('.diff .add').length,
  '| 上下文提示:', document.querySelectorAll('.diff .ctx').length);
console.log('正文:', text('.diff .diff-body').slice(0, 200));

console.log('\n=== 页面 JS 错误 ===');
console.log(pageErrors.length ? pageErrors.join('\n') : '(无)');

// —— 断言表（可证伪，不是“看了一眼”）——
const evKinds = events.filter((p) => p.k === 'ask.event').map((p) => p.ev.k);
const checks = [
  ['审批卡片渲染 .appr（放行前）', apprRendered],
  ['审批卡片放行后移除', !document.querySelector('.appr')],
  ['审批放行后回合收尾 ask.done', evKinds.includes('ask.done') || events.some((p) => p.k === 'ask.done')],
  ['terminal.create 事件', evKinds.includes('terminal.create')],
  ['terminal.output 事件', evKinds.includes('terminal.output')],
  ['terminal.exit 事件(code=0)', events.some((p) => p.k === 'ask.event' && p.ev.k === 'terminal.exit' && p.ev.exitCode === 0)],
  ['终端卡片 .term 渲染', document.querySelectorAll('.term').length >= 1],
  ['终端输出落到 .term-out', text('.term .term-out').includes('fake-terminal-works')],
  ['终端退出码渲染 .term-exit', text('.term .term-exit').includes('code=0')],
  ['plan 卡片 #planbox 存在', !!document.getElementById('planbox')],
  ['plan done 图标(✔) 渲染', document.querySelectorAll('#planbox .done').length >= 1],
  ['plan doing 图标(▶) 渲染', document.querySelectorAll('#planbox .doing').length >= 1],
  ['tool.result 事件(夹具补发)', evKinds.includes('tool.result')],
  ['diff 卡片渲染', document.querySelectorAll('.diff').length >= 1],
  ['diff 删除/新增行渲染', document.querySelectorAll('.diff .del').length >= 1 && document.querySelectorAll('.diff .add').length >= 1],
  ['diff 前后缀裁剪提示', document.querySelectorAll('.diff .ctx').length >= 2],
  ['页面 JS 零错误', pageErrors.length === 0],
];
console.log('\n=== 断言表 ===');
let fail = 0;
for (const [name, ok] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? '✔' : '✘'} ${name}`);
}
console.log(`\n结果: ${checks.length - fail}/${checks.length} 通过`);

await writeFile('/tmp/ui-rendered.html', dom.window.document.documentElement.outerHTML, 'utf8');
console.log('\n渲染后 DOM 已存: /tmp/ui-rendered.html');
process.exit(0);
