#!/usr/bin/env node
// agentbd 负载敏感度基准：空机器 vs 满负载对照
//
// 用法：
//   node scripts/bench.mjs --label "空载"            # 测当前负载下的表现
//   node scripts/bench.mjs --label "load90" --repeat 3
//   node scripts/loadgen.mjs 12 &                    # 另开终端压 12 核当背景负载
//
// 为什么要有这个：README 里"本地模型很慢"的结论此前只给了一个 load≈29 的
// 观测点，没法区分"模型本身慢"和"机器被别人占满导致慢"。这个脚本把负载
// 作为自变量固定下来，才能得出可复现的结论。
//
// 测什么（都选了对负载敏感、且不烧钱的路径）：
//   - doctor   : 10 个引擎并发 spawn + ACP 握手，纯 CPU/进程开销
//   - services : L1+L2 探针，含 TCP connect 与 HTTP
//   - ollama   : 裸 prompt 端到端，最能反映 prefill 在负载下的退化
//   - ask      : 完整 agent 回合（可选，--round，默认关：单次可能 >150s）

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { writeFileSync } from 'node:fs';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const LABEL = arg('--label', 'untitled');
const REPEAT = Number(arg('--repeat', '3'));
const MODEL = arg('--model', 'qwen2.5-coder:14b');
const DO_ROUND = has('--round');
const OLLAMA = 'http://127.0.0.1:11434';

const ms = () => Number(process.hrtime.bigint() / 1000000n);
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { min: s[0], med: s[(s.length / 2) | 0], max: s[s.length - 1] };
};

async function timed(fn) {
  const t0 = ms();
  const v = await fn();
  return { ms: ms() - t0, value: v };
}

/** doctor：抓人读输出里的每引擎毫秒数（比整体耗时更能看出谁被负载拖累） */
async function doctor() {
  // 注意：只要有引擎 FAIL，`doctor` 就以退出码 1 结束。这正是负载测试要捕获的
  // 现象（满载下 agnes 会超时变红），所以绝不能让 execFile 的非零退出把整轮
  // 测量炸掉——手动 spawn 并等它自然结束，无论退出码。
  const stdout = await new Promise((resolve, reject) => {
    const p = spawn('node', ['src/cli.ts', 'doctor'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.on('error', reject);
    p.on('close', () => resolve(buf)); // 不看 code
  });
  // 必须先剥 ANSI：真实输出是 `\x1b[32m✔ PASS\x1b[0m claude  228ms`，
  // 转义序列夹在 PASS 与引擎名之间，直接 \s+ 匹配会得到 0 条（首版就踩了）。
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const per = [];
  for (const line of clean.split('\n')) {
    const m = line.match(/(PASS|FAIL|WARN)\s+(\S+)\s+(\d+)ms/);
    if (m) per.push({ engine: m[2], lamp: m[1], ms: Number(m[3]) });
  }
  const mtotal = clean.match(/(\d+)\/(\d+) 个引擎可用/);
  return {
    engines: per,
    pass: mtotal ? Number(mtotal[1]) : per.filter((e) => e.lamp === 'PASS').length,
    total: mtotal ? Number(mtotal[2]) : per.length,
  };
}

async function services() {
  const { stdout } = await run('node', ['src/cli.ts', 'services', '--json'], {
    cwd: new URL('..', import.meta.url).pathname, maxBuffer: 1 << 22,
  });
  return JSON.parse(stdout);
}

/** 裸 prompt：固定 prompt + num_predict，保证各负载点可比 */
async function ollama(model) {
  const t0 = ms();
  const r = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: '只回复：你好', stream: false, options: { num_predict: 12 } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
  const j = await r.json();
  return { ms: ms() - t0, tokens: j.eval_count };
}

async function round(engine) {
  const t0 = ms();
  try {
    await run('node', ['src/cli.ts', 'ask', engine, '--auto', '--timeout', '180', '只回复：你好'], {
      cwd: new URL('..', import.meta.url).pathname, maxBuffer: 1 << 22, timeout: 200_000,
    });
    return { ms: ms() - t0, ok: true };
  } catch (e) {
    return { ms: ms() - t0, ok: false }; // 超时也是有效数据：它就是"回合不通"
  }
}

// ---- 采集 ----
const rec = {
  label: LABEL,
  at: new Date().toISOString(),
  cpu: os.cpus().length,
  loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
  memFreePct: null,
  runs: [],
};

const dr = [], sv = [], ol = [];
for (let i = 0; i < REPEAT; i++) {
  const d = await timed(doctor);
  const s = await timed(services);
  const o = await timed(() => ollama(MODEL));
  dr.push(d.ms); sv.push(s.ms); ol.push(o.ms);
  rec.runs.push({ i: i + 1, loadavg: os.loadavg().map((n) => Math.round(n)),
    doctor: d.ms, services: s.ms, ollama: o.ms, ollamaTokens: o.value.tokens,
    doctorPass: `${d.value.pass}/${d.value.total}`, engines: d.value.engines });
  process.stderr.write(`  run ${i + 1}/${REPEAT} load=${os.loadavg()[0].toFixed(1)} `
    + `doctor=${d.ms}ms services=${s.ms}ms ollama=${o.ms}ms\n`);
}

if (DO_ROUND) {
  const r = await round(arg('--engine', 'omp'));
  rec.round = r;
  process.stderr.write(`  round(${arg('--engine', 'omp')})=${r.ms}ms ok=${r.ok}\n`);
}

rec.summary = {
  doctor: stat(dr), services: stat(sv), ollama: stat(ol), model: MODEL,
};

// 每个 label 单独落盘，否则满载那次会覆盖掉空载基线（对照就没了）。
const slug = LABEL.replace(/[^\w.-]+/g, '_');
const out = new URL(`../bench-${slug}.json`, import.meta.url).pathname;
writeFileSync(out, JSON.stringify(rec, null, 2));
process.stderr.write(`\n=== ${LABEL} (load ${rec.loadavg[0]}) ===\n`
  + `doctor   min/med/max = ${rec.summary.doctor.min}/${rec.summary.doctor.med}/${rec.summary.doctor.max} ms\n`
  + `services min/med/max = ${rec.summary.services.min}/${rec.summary.services.med}/${rec.summary.services.max} ms\n`
  + `ollama   min/med/max = ${rec.summary.ollama.min}/${rec.summary.ollama.med}/${rec.summary.ollama.max} ms (${MODEL})\n`
  + `→ ${out}\n`);
