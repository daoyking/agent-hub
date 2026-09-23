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

export async function probe(spec: EngineSpec, cwd = process.cwd(), timeoutMs = 25000): Promise<ProbeResult> {
  const t0 = Date.now();
  const agent = await launch(spec, { cwd });
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
