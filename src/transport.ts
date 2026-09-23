/**
 * 传输层：把「一个 ACP agent 子进程」封装成可用的消息流。
 *
 * 关键点（踩过的坑）：
 *  1. macOS GUI/daemon 进程的 PATH 不含 /opt/homebrew/bin → 必须显式注入（见 registry.buildPath）。
 *  2. stderr 必须收集：agent 的初始化错误基本只出现在 stderr，不收集就等于瞎。
 *  3. 退出必须走 stdin.end → SIGTERM → SIGKILL 三级，避免僵尸进程。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { engineEnv } from './registry.ts';
import type { EngineSpec } from './registry.ts';

export type AgentProcess = {
  spec: EngineSpec;
  child: ChildProcess;
  stream: acp.Stream;
  stderrText: () => string;
  dispose: () => void;
};

const STDERR_LIMIT = 4000;

export function launch(spec: EngineSpec, opts: { cwd?: string } = {}): AgentProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: opts.cwd ?? process.cwd(),
    env: engineEnv(spec),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_LIMIT);
  });

  if (!child.stdin || !child.stdout) {
    throw new Error(`无法获取 ${spec.id} 的 stdio（spawn 失败？）`);
  }

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      child.stdin?.end();
    } catch {}
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 2000);
    killTimer.unref?.();
    try {
      child.kill('SIGTERM');
    } catch {}
  };

  return { spec, child, stream, stderrText: () => stderr, dispose };
}

/** 让用户看到 agent 到底在抱怨什么——诊断全靠它 */
export function explainStderr(agent: AgentProcess): string {
  const s = agent.stderrText().trim();
  if (!s) return '(无 stderr 输出)';
  return s.split('\n').slice(-6).join('\n');
}
