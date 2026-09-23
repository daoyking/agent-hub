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
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import * as acp from '@agentclientprotocol/sdk';
import { engineEnv } from './registry.ts';
import type { EngineSpec } from './registry.ts';

export type AgentProcess = {
  spec: EngineSpec;
  child: ChildProcess;
  stream: acp.Stream;
  stderrText: () => string;
  dispose: () => void;
  /** channel=acp-service 时的连接信息（诊断用） */
  service?: { port: number; url: string; fingerprint: string | null };
};

const STDERR_LIMIT = 4000;

export async function launch(spec: EngineSpec, opts: { cwd?: string } = {}): Promise<AgentProcess> {
  if (spec.channel === 'acp-service') return launchService(spec, opts);
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

/* ------------------------------------------------------------------ *
 * acp-service 通道（agnesd 实测逆向，2026-09-23）
 *
 * agnesd 不走 stdio：`agnesd agent` 起本地 HTTPS（自签证书），
 * stdout 打 GOOSED_CERT_FINGERPRINT=<sha256>，
 * 鉴权 = spawn 时注入 AGNES_SERVER__SECRET_KEY，连接 wss://…/acp?token=<key>。
 * 帧格式：WebSocket text frame = 一条 JSON-RPC 消息（ACP）。
 * 桥回 acp.ndJsonStream 后，bus/doctor 完全无感。
 * ------------------------------------------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('无法分配本地端口'))));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launchService(spec: EngineSpec, opts: { cwd?: string } = {}): Promise<AgentProcess> {
  const svc = spec.service;
  if (!svc) throw new Error(`引擎 ${spec.id} 是 acp-service 但缺少 service 配置`);
  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  const env: Record<string, string> = {
    ...engineEnv(spec),
    [svc.portEnv]: String(port),
    [svc.secretEnv]: token,
  };

  const child = spawn(spec.command, spec.args, {
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_LIMIT);
  });

  const info = { port, url: `wss://127.0.0.1:${port}${svc.path ?? '/acp'}`, fingerprint: null as string | null };

  // ① 从 stdout 抓证书指纹（agnesd 在 listening 前打印）
  const prefix = svc.fingerprintPrefix ?? 'GOOSED_CERT_FINGERPRINT=';
  const fingerprint = await new Promise<string | null>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-STDERR_LIMIT); // boot 日志也有诊断价值
      buf += d.toString();
      const idx = buf.indexOf(prefix);
      if (idx >= 0) {
        cleanup();
        resolve(buf.slice(idx + prefix.length).trim().split(/\s+/)[0] ?? null);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`agnesd 启动即退出（exit=${code}）`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等不到 GOOSED_CERT_FINGERPRINT（服务没起来？）'));
    }, 15000);
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    }
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
  info.fingerprint = fingerprint;

  // ② 等端口真正开始监听（指纹打印后随即 listening）
  const deadline = Date.now() + 15000;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`agnesd 端口 ${port} 15s 内未监听`);
    await sleep(150);
  }

  // ③ WebSocket 连接 + 指纹 pin（自签证书用 rejectUnauthorized:false，安全性靠指纹比对）
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`${info.url}?token=${token}`, {
      rejectUnauthorized: false,
      handshakeTimeout: 10000,
    });
    const timer = setTimeout(() => {
      sock.terminate();
      reject(new Error(`连接 ${info.url} 超时`));
    }, 12000);
    sock.once('open', () => {
      clearTimeout(timer);
      const s = sock as unknown as { _socket?: { getPeerCertificate?: () => { fingerprint256?: string } } };
      const actual = s._socket?.getPeerCertificate?.()?.fingerprint256 ?? null;
      if (fingerprint && actual && actual.toUpperCase() !== fingerprint.toUpperCase()) {
        sock.terminate();
        reject(new Error(`TLS 指纹不符：期望 ${fingerprint}，实际 ${actual}`));
        return;
      }
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });

  // ④ WS frame ↔ ndjson 双向桥（bus/doctor 只认 acp.Stream）
  const inbound = new Readable({ read() {} });
  const outbound = new Writable({
    write(chunk, _enc, cb) {
      // 关键坑：ws 默认把 Buffer 发成 binary frame，而 ACP 只认 text frame
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk.toString('utf8'));
      cb();
    },
  });
  const endInbound = () => inbound.push(null);
  ws.once('close', endInbound);
  ws.once('error', endInbound);
  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      inbound.push(text.endsWith('\n') ? text : text + '\n');
      return;
    }
    // 批量帧（JSON 数组）拆成逐行——ndJsonStream 一行一条
    if (Array.isArray(parsed)) for (const item of parsed) inbound.push(JSON.stringify(item) + '\n');
    else inbound.push(JSON.stringify(parsed) + '\n');
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(outbound) as WritableStream<Uint8Array>,
    Readable.toWeb(inbound) as unknown as ReadableStream<Uint8Array>,
  );

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      ws.close(1001);
    } catch {}
    setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
    }, 500).unref?.();
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

  return { spec, child, stream, stderrText: () => stderr, dispose, service: info };
}
