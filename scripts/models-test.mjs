/**
 * `pickFreeModels` 的回归测试：纯函数、不碰网络、不碰缓存。
 *
 * 这个函数的价值全在**挡住定价表里的三个坑**，所以测试也只钉这三件事：
 *   1. sample_spec（文档占位符，成本恰好是 0）不能变成"免费模型"；
 *   2. 只有 input=0、output 缺失的条目不能算免费（未知 ≠ 免费）；
 *   3. 标价 0 但要自付托管费的（azure_ai/sagemaker/vertex_ai）不能混进"免费额度"。
 * 跑：node scripts/models-test.mjs
 */
import { pickFreeModels, summarize } from '../src/models.ts';

const zero = { input_cost_per_token: 0, output_cost_per_token: 0 };
const table = {
  // 坑 1：文档占位符，provider 是个 URL，mode 写着 "one of: ..."，成本恰好 0
  sample_spec: { ...zero, litellm_provider: 'one of https://docs.litellm.ai/docs/providers', mode: 'one of: chat, embedding' },
  // 正常免费：厂商免费额度
  'gemini/gemini-2.0-flash': { ...zero, litellm_provider: 'gemini', mode: 'chat', max_input_tokens: 1048576 },
  'gemini/text-embedding-004': { ...zero, litellm_provider: 'gemini', mode: 'embedding', max_tokens: 2048 },
  // 本地自跑
  'ollama/llama3.2': { ...zero, litellm_provider: 'ollama', mode: 'chat', max_input_tokens: 131072 },
  // 坑 3：标价 0，但要自付托管
  'azure_ai/cohere-rerank-v3': { ...zero, litellm_provider: 'azure_ai', mode: 'rerank' },
  'sagemaker/x': { ...zero, litellm_provider: 'sagemaker', mode: 'chat' },
  // 坑 2：只有 input=0，output 缺失 —— 未知，不能当免费
  'perplexity/sonar-small-online': { input_cost_per_token: 0, litellm_provider: 'perplexity', mode: 'chat' },
  // 确实要钱
  'gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001, litellm_provider: 'openai', mode: 'chat' },
  // 输出成本非 0 但输入 0
  'weird/half': { input_cost_per_token: 0, output_cost_per_token: 0.5, litellm_provider: 'weird', mode: 'chat' },
  // 缺 provider / provider 是脏值
  'noprov': { ...zero, mode: 'chat' },
  'urlprov': { ...zero, litellm_provider: 'see https://example.com/x', mode: 'chat' },
  // 非对象值、数组
  notAnObject: 'hello',
  arrValue: [1, 2, 3],
  // mode 是脏值 → 兜底成 chat
  'odd/mode': { ...zero, litellm_provider: 'oddco', mode: 'one of: chat, embedding' },
};

const got = pickFreeModels(table);
const ids = got.map((m) => m.id);
const checks = [
  ['总数 6', got.length === 6],
  ['坑1 sample_spec 被排除', !ids.includes('sample_spec')],
  ['坑1 provider 含空格/URL 的被排除', !ids.includes('urlprov')],
  ['坑1 缺 provider 的被排除', !ids.includes('noprov')],
  ['非对象值被跳过', !ids.includes('notAnObject') && !ids.includes('arrValue')],
  ['坑2 output 缺失的不算免费', !ids.includes('perplexity/sonar-small-online')],
  ['output 非 0 的不算免费', !ids.includes('weird/half')],
  ['付费模型被排除', !ids.includes('gpt-4o')],
  ['本地自跑归 local', got.find((m) => m.id === 'ollama/llama3.2')?.kind === 'local'],
  ['云端免费额度归 free-tier', got.find((m) => m.id === 'gemini/gemini-2.0-flash')?.kind === 'free-tier'],
  ['坑3 azure_ai 归 self-hosted', got.find((m) => m.id === 'azure_ai/cohere-rerank-v3')?.kind === 'self-hosted'],
  ['坑3 sagemaker 归 self-hosted', got.find((m) => m.id === 'sagemaker/x')?.kind === 'self-hosted'],
  ['上下文优先取 max_input_tokens', got.find((m) => m.id === 'gemini/gemini-2.0-flash')?.maxInput === 1048576],
  ['没有 max_input_tokens 时回退 max_tokens', got.find((m) => m.id === 'gemini/text-embedding-004')?.maxInput === 2048],
  ['缺上下文时为 undefined（不是 0）', got.find((m) => m.id === 'azure_ai/cohere-rerank-v3')?.maxInput === undefined],
  ['mode 脏值兜底成 chat', got.find((m) => m.id === 'odd/mode')?.mode === 'chat'],
];

const s = summarize(got);
checks.push(['summarize 总数一致', s.total === got.length]);
checks.push(['summarize 三类相加等于总数', s.byKind.local + s.byKind['free-tier'] + s.byKind['self-hosted'] === s.total]);
// chat 的是这 4 条：gemini-2.0-flash、ollama/llama3.2、sagemaker/x、odd/mode（mode 脏值兜底）
checks.push(['summarize chat 计数正确', s.chat === 4]);
checks.push(['空表不炸', pickFreeModels({}).length === 0 && summarize([]).total === 0]);

let fail = 0;
for (const [name, ok] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? '✔' : '✘'} ${name}`);
}
console.log(`\n${checks.length - fail}/${checks.length} 通过`);
process.exit(fail ? 1 : 0);
