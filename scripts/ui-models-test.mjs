/**
 * 面板「免费模型」分组的渲染回归：jsdom 载入真实 ui.html，桩掉 /api/state 与 /api/models。
 *
 * 钉三件事：
 *   1) 三类**必须分开标色**（免费/本地/自付）——混成一片"免费"就是在骗人；
 *   2) 预热中 / 未就绪 / 端点挂了都要有**说人话**的提示，不能白屏也不能装作有数据；
 *   3) 分组默认收起（154 行平铺就是噪音，与"未登记服务默认隐藏"同一个原则），
 *      且要参与全局搜索。
 * 跑：node scripts/ui-models-test.mjs
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = 'http://127.0.0.1:7787';
const html = await readFile('/Users/jindy/Projects/agent-hub/src/ui.html', 'utf8');
const state = JSON.parse(await readFile(new URL('./fixtures/state-sample.json', import.meta.url), 'utf8'));

const MODELS = {
  ready: true,
  warming: false,
  stale: false,
  fetchedAt: '2026-09-29T12:00:00Z',
  totalInTable: 4422,
  summary: { total: 4, byKind: { local: 1, 'free-tier': 2, 'self-hosted': 1 }, byMode: { chat: 3, rerank: 1 }, chat: 3 },
  models: [
    { id: 'gemini/gemini-2.0-flash', provider: 'gemini', mode: 'chat', kind: 'free-tier', maxInput: 1048576 },
    { id: 'openrouter/qwen3:free', provider: 'openrouter', mode: 'chat', kind: 'free-tier' },
    { id: 'ollama/llama3.2', provider: 'ollama', mode: 'chat', kind: 'local', maxInput: 131072 },
    { id: 'azure_ai/cohere-rerank-v3', provider: 'azure_ai', mode: 'rerank', kind: 'self-hosted' },
  ],
};

/** 起一个页面；modelsResp 决定 /api/models 返回什么（也可传 null 模拟端点 404） */
async function page(modelsResp) {
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
      win.fetch = (u, o) => {
        const url = typeof u === 'string' ? u : u?.url ?? String(u);
        if (url.includes('/api/models')) {
          if (modelsResp === null) return Promise.reject(new Error('404'));
          return Promise.resolve({ ok: true, status: 200, json: async () => modelsResp });
        }
        const payload = url.includes('/api/state') ? state : {};
        return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => '' });
      };
    },
  });
  await new Promise((r) => setTimeout(r, 300)); // 等首帧 + loadModels
  return { dom, doc: dom.window.document, Event: dom.window.Event, errors: pageErrors };
}

const checks = [];
const rows = (doc) => [...doc.querySelectorAll('#free .row')];
const blocks = (doc) => [...doc.querySelectorAll('#free .blk')].map((e) => e.textContent.trim());

// ── 场景 1：已就绪 ──
{
  const { doc, Event } = await page(MODELS);
  checks.push(['分组默认收起（154 行不该平铺）', doc.getElementById('g-free').open === false]);
  checks.push(['三个分类块都在', blocks(doc).length === 3]);
  checks.push(['三块标题带各自数量', /云端免费额度.*（2）/.test(blocks(doc)[0]) && /本地自跑.*（1）/.test(blocks(doc)[1]) && /自付.*（1）/.test(blocks(doc)[2])]);
  checks.push(['三类徽章用三种颜色（免费/本地/自付）',
    doc.querySelectorAll('#free em.kfree').length === 2 &&
    doc.querySelectorAll('#free em.klocal').length === 1 &&
    doc.querySelectorAll('#free em.kself').length === 1]);
  checks.push(['徽章文字分别是 免费/本地/自付', ['免费', '本地', '自付'].every((t) => [...doc.querySelectorAll('#free em')].some((e) => e.textContent === t))]);
  checks.push(['行里有 provider/用途/上下文', /gemini.*chat.*1M/.test(rows(doc)[0].textContent.replace(/\s+/g, ' '))]);
  checks.push(['计数显示总数 4', doc.getElementById('c-free').textContent.trim() === '4']);

  // 搜索：面板顶栏那个筛选框也要能筛免费模型
  const q = doc.getElementById('q');
  q.value = 'gemini';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  checks.push(['搜索能筛免费模型（只剩 1 行）', rows(doc).length === 1 && rows(doc)[0].textContent.includes('gemini')]);
  checks.push(['搜索时计数变成 1/4', doc.getElementById('c-free').textContent.trim() === '1/4']);
  checks.push(['搜索时自动展开该分组（别让命中藏在收起处）', doc.getElementById('g-free').open === true]);
  q.value = '';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  checks.push(['清空搜索后恢复 4 行', rows(doc).length === 4]);
}

// ── 场景 2：预热中（后端 ready:false + warming:true）──
{
  const { doc } = await page({ ready: false, warming: true, hint: '首次使用需下载约 3MB 定价表' });
  const txt = doc.querySelector('#free .row')?.textContent ?? '';
  checks.push(['预热中如实说"正在预热"，不装作有数据', /预热/.test(txt) && rows(doc).length === 1]);
  checks.push(['预热时计数留空（不是 0，那会被当成"没有免费模型"）', doc.getElementById('c-free').textContent.trim() === '']);
}

// ── 场景 3：未就绪且没在预热（下载失败）──
{
  const { doc } = await page({ ready: false, warming: false, hint: '首次使用需下载约 3MB 定价表（30~40 秒）；也可以先跑 `agentbd models` 预热' });
  const txt = doc.querySelector('#free .row')?.textContent ?? '';
  checks.push(['未就绪时给出**怎么解决**的提示', /agentbd models/.test(txt)]);
}

// ── 场景 4：端点不可用 ──
{
  const { doc, errors } = await page(null);
  checks.push(['端点挂了显示"(未取到)"而不是白屏', (doc.querySelector('#free .row')?.textContent ?? '').includes('未取到')]);
  checks.push(['端点挂了页面 JS 仍零错误', errors.length === 0]);
}

let fail = 0;
for (const [name, ok] of checks) { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}`); }
console.log(`\n${checks.length - fail}/${checks.length} 通过`);
process.exit(fail ? 1 : 0);
