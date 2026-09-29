#!/usr/bin/env node
// services init 回归测试：验证「已有清单不被污染」+「--all 不抹手工字段」。
// 隔离手法：SERVICES_FILE 在模块加载时由 os.homedir() 求出，而 Node 的 homedir()
// 尊重 $HOME —— 所以把 HOME 指到临时目录就能安全地跑真实 CLI，不碰 ~/.agentbd。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const home = mkdtempSync(join(tmpdir(), 'agentbd-init-'));
mkdirSync(join(home, '.agentbd'), { recursive: true });
const MANIFEST = join(home, '.agentbd', 'services.json');
const env = { ...process.env, HOME: home };
const init = (...a) =>
  execFileSync('node', [CLI, 'services', 'init', ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const read = () => JSON.parse(readFileSync(MANIFEST, 'utf8')).services;
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };

// 1) 首次：清单为空 → 应全量写入（保证开箱可用）
init();
const first = read();
check(first.length > 0, `首次 init 写入清单（${first.length} 条）`);

// 2) 模拟人工策划：只留 1 条并写上手注
const keep = first.find((s) => s.ports?.length) ?? first[0];
keep.notes = '人工策划保留';
writeFileSync(MANIFEST, JSON.stringify({ services: [keep] }, null, 2));

// 3) 再次 init：**不得改动**（这正是被修掉的 bug：每次 init 把全部发现灌回来）
init();
const after = read();
check(after.length === 1, `再次 init 未污染清单（仍 ${after.length} 条，修复前会涨到 ${first.length}）`);
check(after[0]?.notes === '人工策划保留', 'init 未改动 notes');
check(JSON.stringify(after[0]?.ports) === JSON.stringify(keep.ports), 'init 未改动 ports');

// 4) --all：允许扩充，但手工字段必须存活
init('--all');
const all = read();
check(all.length > 1, `--all 才做全量收录（${all.length} 条）`);
const kept = all.find((s) => s.id === keep.id);
check(kept?.notes === '人工策划保留', '--all 未抹掉手工 notes');
check(JSON.stringify(kept?.ports) === JSON.stringify(keep.ports), '--all 未覆盖手工 ports');

rmSync(home, { recursive: true, force: true });
console.log(fails.length ? `\n✗ ${fails.length} 项失败` : '\n✓ 全部通过');
process.exit(fails.length ? 1 : 0);
