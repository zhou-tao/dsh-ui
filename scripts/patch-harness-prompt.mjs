#!/usr/bin/env node
// 修补已安装 harness 的 terminal-bash 提示符校验：
// tool-bash-persistent 会把 PS1 改成 __DSH_PERSISTENT_BASH_PROMPT__，
// 而 dsh-terminal-bash 只认 "dsh> " 作为合法提示符文本（promptTextSeen），
// 导致持久化 bash 每个命令都走 3.5s 静默兜底而"响应慢"。
// 本脚本让 terminal 同时认可持久化标记（前 6 字符 __DSH_）为合法提示符。
// 用法：node scripts/patch-harness-prompt.mjs [harness_root]
//   harness_root 默认 = 通过 npx 定位 @deepseek-ai/dsh 的安装目录。
// 说明：harness 升级后需重新执行；补丁仅改已安装文件，不改仓库内任何源码。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const TARGET_REL = 'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js';
const OLD = 'this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT;';
const NEW = 'this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT || this.promptTail === "__DSH_"; // dsh-ui patch: tool-bash-persistent 的 PS1 标记同样视为合法提示符';

function locateRoot() {
  const explicit = process.argv[2];
  if (explicit) return resolve(explicit);
  // 定位 dsh 的安装位置：要求 node_modules/@deepseek-ai/dsh/package.json 存在
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve('@deepseek-ai/dsh/package.json');
    const root = pkg.slice(0, pkg.indexOf('node_modules/@deepseek-ai/dsh/package.json'));
    if (root) return root;
  } catch { /* fall through */ }
  return process.cwd();
}

const root = locateRoot();
const target = resolve(root, TARGET_REL);
if (!existsSync(target)) {
  console.error('[patch] 未找到 ' + target);
  console.error('[patch] 请传入 harness 根目录，例如：node scripts/patch-harness-prompt.mjs ~/.npm/_npx/<hash>');
  process.exit(1);
}
const src = readFileSync(target, 'utf8');
if (src.includes('__DSH_')) {
  console.log('[patch] 已打过补丁，跳过：' + target);
  process.exit(0);
}
if (!src.includes(OLD)) {
  console.error('[patch] 未匹配到目标代码（版本可能已变化），请检查 ' + target);
  process.exit(1);
}
writeFileSync(target, src.replace(OLD, NEW));
console.log('[patch] 已修补（重启 harness 后生效）：' + target);
