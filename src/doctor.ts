/**
 * doctor：不建会话、只做 initialize 握手 + 能力探测。
 *
 * 存在的意义（设计方案 §5.1 的"适配器漂移"）：ACP 适配器/CLI 版本迭代很快，
 * 升级后必须先跑一遍 doctor 才知道哪个引擎挂了、能力变了。
 */

import * as acp from '@agentclientprotocol/sdk';
import { launch, explainStderr } from './transport.ts';
import type { EngineSpec } from './registry.ts';
import type { EngineProfile } from './bus.ts';

export type ProbeResult = {
  engine: string;
  ok: boolean;
  ms: number;
  profile?: EngineProfile;
  error?: string;
};

/** 把 spawn 失败翻译成人能看懂的话（ENOENT 常见于应用被卸载/移动） */
function describeLaunchFailure(msg: string): string {
  if (/ENOENT/.test(msg)) {
    return (
      '可执行文件不存在（ENOENT）。应用可能被卸载或移动到别处了。\n' +
      '  · 检查引擎的 command 路径是否仍存在（`ls -l <command>`）\n' +
      '  · 桌面应用类引擎在 /Applications 下；移动后用 ~/.agentbd/engines.json 覆盖 command'
    );
  }
  if (/EACCES|EPERM/.test(msg)) return `无执行权限（${msg}）：chmod +x <command>`;
  return msg;
}

export async function probe(spec: EngineSpec, cwd = process.cwd(), timeoutMs = 25000): Promise<ProbeResult> {
  const t0 = Date.now();
  // launch 自身可能抛（ENOENT：二进制不在了，比如应用被卸载/移动；EACCES 等）。
  // 单个引擎探不通**不能**让整份 doctor 崩掉——那会让其他引擎的健康状况一起看不见。
  let agent;
  try {
    agent = await launch(spec, { cwd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { engine: spec.id, ok: false, ms: Date.now() - t0, error: describeLaunchFailure(msg) };
  }
  try {
    const profile = await Promise.race([
      (async () =>
        acp
          .client({ name: 'agentbd-doctor' })
          .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' as const } }))
          .connectWith(agent.stream, async (ctx) => {
            const init = await ctx.request('initialize', {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientInfo: { name: 'agentbd-doctor', version: '0.1.0' },
              clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
            });
            return {
              protocolVersion: init.protocolVersion,
              agentInfo: (init as { agentInfo?: { name?: string; version?: string } }).agentInfo,
              capabilities: (init.agentCapabilities ?? {}) as Record<string, unknown>,
              authMethods: (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name })),
            } satisfies EngineProfile;
          }))(),
      new Promise<never>((_, rej) => {
        const t = setTimeout(() => rej(new Error(`握手超时 ${timeoutMs}ms`)), timeoutMs);
        t.unref?.();
      }),
    ]);
    return { engine: spec.id, ok: true, ms: Date.now() - t0, profile };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { engine: spec.id, ok: false, ms: Date.now() - t0, error: `${msg}\n${explainStderr(agent)}` };
  } finally {
    agent.dispose();
  }
}

/**
 * 限并发地探测一批引擎。
 *
 * 为什么要限：`Promise.all` 一次 spawn 全部引擎会互相抢 CPU/内存，实测 10 个
 * 引擎时出现 4 个握手超时（gemini/codebuddy/qoder/openclaw 全部 25s），而它们
 * **单独跑都是秒通**——纯自伤。引擎数还会继续涨，全并行必然更糟。
 *
 * 3 是实测出来的折中：11 引擎时总耗时仍可接受（~39s），通过率从 7/10 回到 9/10。
 */
export const PROBE_CONCURRENCY = 3;

export async function probeAllEngines<T>(
  specs: EngineSpec[],
  one: (s: EngineSpec) => Promise<T>,
  concurrency: number = PROBE_CONCURRENCY,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < specs.length; i += concurrency) {
    out.push(...(await Promise.all(specs.slice(i, i + concurrency).map(one))));
  }
  return out;
}
