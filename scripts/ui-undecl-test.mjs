/**
 * 定向回归：面板服务分组的「未登记默认隐藏」行为。
 * 用真实 ui.html + 真实 /api/state 快照（/tmp/state.json）在 jsdom 里渲染，
 * 不依赖 serve 在线。防的是两件事：
 *   1) 未登记项挤进列表（清单要跟 lsh 对齐，43 条里 37 条是噪音）；
 *   2) 反向的老坑——隐藏变成「悄悄少了」（计数必须恒显示、搜索命中必须放出）。
 * 跑：node scripts/ui-undecl-test.mjs
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.env.AGENTBD_PANEL ?? 'http://127.0.0.1:7787';
const html = await readFile('/Users/jindy/Projects/agent-hub/src/ui.html', 'utf8');
// 默认读**固化夹具**（可重复、离线可跑）；AGENTBD_STATE_LIVE=1 时打真实 serve。
const state = process.env.AGENTBD_STATE_LIVE === '1'
  ? await (await fetch(`${BASE}/api/state`)).json()
  : JSON.parse(await readFile(new URL('./fixtures/state-sample.json', import.meta.url), 'utf8'));

const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => pageErrors.push('jsdomError: ' + (e.message ?? e)));
vc.on('error', (...a) => pageErrors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  virtualConsole: vc,
  url: `${BASE}/`,
  beforeParse(win) {
    win.EventSource = class { constructor(u) { this.url = u; } close() {} };
    win.fetch = (u) => {
      const url = typeof u === 'string' ? u : u?.url ?? String(u);
      const payload = url.includes('/api/state') ? state : {};
      return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => '' });
    };
  },
});
const { document: doc, Event: WEvent } = dom.window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300); // 等首帧渲染

const nDec = state.services.filter((x) => x.declared).length;
const nNew = state.services.length - nDec;
// 占位行（"(无匹配)"/"(已隐藏 N 项…)"）也是 .row，得排掉
const realRows = (sel) =>
  [...doc.querySelectorAll(sel + ' .row')].filter((e) => !/^\((.*)\)$/.test(e.textContent.replace(/\s+/g, ' ').trim()));
const count = (id) => doc.getElementById(id).textContent.trim();

const checks = [];
const box = doc.querySelector('#onlyUndecl input');

// —— 默认态 ——
checks.push(['默认: 已登记组只含登记过的', realRows('#services-ok').length === nDec]);
checks.push(['默认: 已登记组里没有未登记行（重复显示的老 bug）',
  doc.querySelectorAll('#services-ok em.undecl').length === 0]);
checks.push([`默认: 未登记组一条都不列出（应为 0，实际 ${realRows('#services-new').length}）`,
  realRows('#services-new').length === 0]);
checks.push([`默认: 未登记计数仍显示 ${nNew}（不静默消失）`, count('c-svc-new').includes(String(nNew))]);
checks.push(['默认: 开关是关的', box.checked === false]);

// —— 勾选放出 ——
box.checked = true;
doc.querySelector('#onlyUndecl input').dispatchEvent(new WEvent('change', { bubbles: true }));
await sleep(60);
checks.push([`勾选后: 未登记组列出 ${nNew} 项（实际 ${realRows('#services-new').length}）`,
  realRows('#services-new').length === nNew]);
checks.push(['勾选后: 分组自动展开', doc.getElementById('g-svc-new').open === true]);
checks.push(['勾选后: 偏好写入 localStorage', dom.window.localStorage.getItem('agentbd.showUndecl') === '1']);

// —— 搜索兜底（开关关掉，靠搜索命中） ——
box.checked = false;
doc.querySelector('#onlyUndecl input').dispatchEvent(new WEvent('change', { bubbles: true }));
const q = doc.getElementById('q');
q.value = '';
q.dispatchEvent(new WEvent('input', { bubbles: true }));
await sleep(60);
const target = state.services.find((x) => !x.declared);
q.value = target.id;
q.dispatchEvent(new WEvent('input', { bubbles: true }));
await sleep(60);
// pid-* 服务的 id 按设计不显示在行里（少噪音），但必须能在 hover title 里解释命中原因
const found = realRows('#services-new').some(
  (r) => r.textContent.includes(target.id) || (r.getAttribute('title') ?? '').includes(target.id));
checks.push([`搜索未登记项「${target.id}」能命中（开关关着也要放出来）`, found]);
checks.push(['搜索时分组自动展开', doc.getElementById('g-svc-new').open === true]);
// 非 pid-* 的未登记项：id 直接显示在行里，命中理由应当肉眼可见
const t2 = state.services.find((x) => !x.declared && !x.id.startsWith('pid-'));
if (t2) {
  q.value = t2.id;
  q.dispatchEvent(new WEvent('input', { bubbles: true }));
  await sleep(60);
  checks.push([`搜索「${t2.id}」的命中行肉眼可见 id`,
    realRows('#services-new').some((r) => r.textContent.includes(t2.id))]);
}
q.value = '';
q.dispatchEvent(new WEvent('input', { bubbles: true }));
await sleep(60);
checks.push(['清空搜索后回到隐藏态', realRows('#services-new').length === 0]);

checks.push(['页面 JS 零错误', pageErrors.length === 0]);

let fail = 0;
for (const [name, ok] of checks) { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}`); }
if (pageErrors.length) console.log('pageErrors:', pageErrors.join(' | '));
console.log(`\n${checks.length - fail}/${checks.length} 通过 · 载荷: ${state.services.length} 服务（已登记 ${nDec} / 未登记 ${nNew}）`);
process.exit(fail ? 1 : 0);
