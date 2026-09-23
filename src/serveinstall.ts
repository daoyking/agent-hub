/**
 * launchd 按需唤醒（on-demand）安装器：`agentbd serve install|uninstall|status`。
 *
 * 机制（inetd 兼容模式，纯 Node 无原生依赖）：
 *   plist 声明 Sockets.Listeners + inetdCompatibility.Wait=true
 *   → launchd 常驻持有 127.0.0.1:7787 的监听 socket（内核态，零进程）
 *   → 首个 TCP 连接到达时 launchd 才 bootstrap 本程序，监听 fd 出现在 stdin（fd 0）
 *   → server.listen({fd:0}) 接管；空闲 N 分钟无连接自动退出，下次连接再拉起
 *   ⇒ 不用时系统里根本没有 agentbd 进程，内存/CPU 占用为 0。
 */

import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

export const SERVE_LABEL = 'ai.agentbd.serve';
const PLIST = path.join(homedir(), 'Library', 'LaunchAgents', `${SERVE_LABEL}.plist`);
const LOG_DIR = path.join(homedir(), '.agentbd');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');

const exists = (p: string): Promise<boolean> =>
  access(p, constants.R_OK).then(
    () => true,
    () => false,
  );

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildPlist(port: number, idleMin: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(CLI)}</string>
    <string>serve</string>
    <string>--fd</string>
    <string>0</string>
    <string>--idle</string>
    <string>${idleMin}</string>
  </array>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockServiceName</key>
      <string>${port}</string>
      <key>SockNodeName</key>
      <string>127.0.0.1</string>
    </dict>
  </dict>
  <key>inetdCompatibility</key>
  <dict>
    <key>Wait</key>
    <true/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${esc(path.join(LOG_DIR, 'serve.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(LOG_DIR, 'serve.err.log'))}</string>
</dict>
</plist>
`;
}

const domain = (): string => `gui/${process.getuid?.() ?? 501}`;

/** 端口此刻是否已被占用（安装前检查，避免与手动 serve 冲突） */
async function portBusy(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(true));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
}

export async function serveInstall(port: number, idleMin: number): Promise<void> {
  if (await portBusy(port)) {
    throw new Error(
      `127.0.0.1:${port} 正被占用（可能有手动 agentbd serve 在跑）。先关掉它再 install。`,
    );
  }
  await writeFile(PLIST, buildPlist(port, idleMin), 'utf8');
  // 已加载过先卸再装（幂等重装）
  await exec('launchctl', ['bootout', `${domain()}/${SERVE_LABEL}`]).catch(() => {});
  await exec('launchctl', ['bootstrap', domain(), PLIST]);
  console.log(`已安装并加载: ${PLIST}`);
  console.log(`  端口 127.0.0.1:${port} 现在由 launchd 持有（进程数为 0）`);
  console.log(`  打开 http://127.0.0.1:${port} 即自动拉起；空闲 ${idleMin} 分钟自动退出`);
  console.log(`  日志: ${path.join(LOG_DIR, 'serve.{out,err}.log')}`);
}

export async function serveUninstall(): Promise<void> {
  if (!(await exists(PLIST))) {
    console.log('(未安装)');
    return;
  }
  await exec('launchctl', ['bootout', `${domain()}/${SERVE_LABEL}`]).catch(() => {});
  await unlink(PLIST);
  console.log(`已卸载并删除: ${PLIST}`);
}

export async function serveStatus(): Promise<void> {
  console.log(`plist: ${(await exists(PLIST)) ? PLIST : '(未安装)'}`);
  try {
    const { stdout } = await exec('launchctl', ['print', `${domain()}/${SERVE_LABEL}`]);
    const state = stdout.match(/state = (\w+)/)?.[1] ?? '?';
    const pid = stdout.match(/pid = (\d+)/)?.[1];
    console.log(`launchd: state=${state}${pid ? ` pid=${pid}` : '（未在跑，等待首个连接拉起）'}`);
  } catch {
    console.log('launchd: 未加载');
  }
  if (await exists(PLIST)) {
    const raw = await readFile(PLIST, 'utf8');
    console.log(`端口: ${raw.match(/SockServiceName<\/key>\s*<string>(\d+)/)?.[1] ?? '?'} · 空闲退出: ${raw.match(/--idle<\/string>\s*<string>([\d.]+)/)?.[1] ?? '?'}min`);
  }
}
