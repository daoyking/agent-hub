#!/usr/bin/env node
/**
 * 受控 fake ACP agent —— 回归夹具（不接任何真实模型）。
 *
 * 一个 prompt 回合内依次打出总线 P2 的全部新事件面：
 *   1. plan 更新（两步，一完成一进行）
 *   2. terminal/create（整串 command 无 args，复现 agnes 形态）→ wait_for_exit → release
 *   3. tool_call 携带 diff 内容（前缀/后缀裁剪渲染的输入）
 *   4. agent_message_chunk 汇总
 *
 * 用法：node scripts/fake-acp-agent.mjs（stdio ACP，由 runTurn 拉起）
 */
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const app = acp.agent({ name: 'fake-acp-agent' });

app.onRequest('initialize', async () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: {},
}));

app.onRequest('session/new', async () => ({ sessionId: 'fake-s1' }));

app.onRequest('session/prompt', async (ctx) => {
  const sessionId = ctx.params.sessionId;
  const cl = ctx.client;

  // ① plan 时间线
  await cl.notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: '步骤一：跑终端命令', status: 'in_progress', priority: 'medium' },
        { content: '步骤二：改文件', status: 'pending', priority: 'medium' },
      ],
    },
  });

  // ② terminal 全生命周期（整串 command、无 args——agnes 真实形态；deny 模式下这里会抛错）
  let termNote;
  try {
    const { terminalId } = await cl.request('terminal/create', {
      sessionId,
      command: 'echo fake-terminal-works',
    });
    const exit = await cl.request('terminal/wait_for_exit', { sessionId, terminalId });
    await cl.request('terminal/release', { sessionId, terminalId });
    termNote = `terminal exit=${exit.exitCode}`;
  } catch (err) {
    termNote = `terminal 被拒: ${err instanceof Error ? err.message : String(err)}`;
  }

  // ③ diff（oldText/newText 有公共前后缀，验证裁剪渲染）
  await cl.notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-diff-1',
      title: '编辑 demo.txt',
      kind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: '/tmp/acp-e2e/demo.txt',
          oldText: 'line1\nline2\nline3',
          newText: 'line1\nCHANGED\nline3',
        },
      ],
    },
  });

  // ④ 收尾文本
  await cl.notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `fake done · ${termNote}` },
    },
  });
  return { stopReason: 'end_turn' };
});

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
