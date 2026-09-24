/**
 * P2-2 告警通知 —— 面板关着也要知道的三件事：审批挂起、预算触线、服务红灯。
 *
 * 通道（可叠加）：
 *  1. macOS 系统通知（osascript display notification，无需任何依赖）
 *  2. 自定义 webhook（POST JSON，适合接 Bark/企业微信/Slack 桥）
 *
 * 设计约束：
 *  - 配置在 `~/.agentbd/notify.json`（仓库之外，与 budget.json 同风格）：
 *      { "enabled": true, "webhook": "https://…", "minIntervalSec": 60 }
 *    缺文件 = 默认开启系统通知；enabled=false 全局静默。
 *  - 去抖：同 tag 在 minIntervalSec 内只发一次（红灯抖动、审批连发不刷屏）。
 *  - 通知绝不影响业务：任何失败都静默吞掉，调用方一律 `void notify(...)`。
 */

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const NOTIFY_FILE = path.join(os.homedir(), '.agentbd', 'notify.json');

export type NotifyConfig = {
  /** false = 全局静默（默认 true） */
  enabled?: boolean;
  /** 可选 webhook：POST {title, body, tag, at} */
  webhook?: string;
  /** 同 tag 去抖间隔（秒），默认 60 */
  minIntervalSec?: number;
};

const lastSent = new Map<string, number>();

async function loadConfig(): Promise<NotifyConfig> {
  try {
    return JSON.parse(await readFile(NOTIFY_FILE, 'utf8')) as NotifyConfig;
  } catch {
    return { enabled: true };
  }
}

/** AppleScript 字符串字面量转义（反斜杠在前，引号在后） */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function notify(
  title: string,
  body: string,
  opts?: { tag?: string; minIntervalSec?: number },
): Promise<void> {
  try {
    const cfg = await loadConfig();
    if (cfg.enabled === false) return;
    const tag = opts?.tag ?? title;
    const minMs = (opts?.minIntervalSec ?? cfg.minIntervalSec ?? 60) * 1000;
    const now = Date.now();
    if (now - (lastSent.get(tag) ?? 0) < minMs) return;
    lastSent.set(tag, now);

    // ① macOS 系统通知：detached + stdio ignore，不阻塞不泄漏
    const p = spawn(
      'osascript',
      [
        '-e',
        `display notification "${escAppleScript(body).slice(0, 220)}" with title "${escAppleScript(title)}"`,
      ],
      { stdio: 'ignore', detached: true },
    );
    p.on('error', () => {});
    p.unref();

    // ② webhook（可选），5s 超时
    if (cfg.webhook) {
      await fetch(cfg.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, tag, at: now }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  } catch {
    /* 通知永远不该炸业务 */
  }
}
