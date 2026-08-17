#!/usr/bin/env node
// 把 plugins/ 下的 dsh 插件安装进 harness profile（默认 ~/.dsh/profiles/web）。
// 用法：pnpm plugins:install [--profile web] [--remove]
// 安装后需重启 harness（或重启桌面端）才会生效。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const REPO = resolve(new URL('..', import.meta.url).pathname); // dsh-ui 根目录
const argProfile = process.argv.findIndex((a) => a === '--profile');
const profile = argProfile >= 0 ? process.argv[argProfile + 1] : process.env.DSH_PROFILE ?? 'web';
const remove = process.argv.includes('--remove');
const profileDir = join(homedir(), '.dsh', 'profiles', profile);
const patchFile = join(profileDir, 'cordis.patch.yml');
const pkgFile = join(profileDir, 'package.json');

const PLUGINS = [
  { id: 'dsh-deep-ui', dir: 'plugins/dsh-deep-ui', desc: 'UI 层增强（会话思考过程折叠）' },
  { id: 'dsh-remote', dir: 'plugins/dsh-remote', desc: '手机互联（H5 远程互联）' },
];

function fail(msg) {
  console.error('[plugins] 错误: ' + msg);
  process.exit(1);
}
if (!existsSync(profileDir)) fail('profile 目录不存在: ' + profileDir + '（请先启动过一次 harness）');
if (!existsSync(patchFile)) fail('cordis.patch.yml 不存在');

const MARK = '# ── dsh-ui 插件（安装脚本生成；--remove 可移除） ──';
const NL = String.fromCharCode(10);
const insertBlock =
  NL + MARK + NL +
  '- insert:' + NL +
  PLUGINS.map((p) => '    - id: ' + p.id + NL + "      name: '" + p.id + "'").join(NL) +
  NL;

if (remove) {
  let patch = readFileSync(patchFile, 'utf8');
  const start = patch.indexOf(MARK);
  if (start >= 0) {
    const rest = patch.indexOf(NL + '- insert:', start + 1);
    const end = rest >= 0 ? rest : patch.length;
    patch = patch.slice(0, start) + patch.slice(end);
    writeFileSync(patchFile, patch);
    console.log('[plugins] 已从 cordis.patch.yml 移除插件行');
  } else {
    console.log('[plugins] cordis.patch.yml 中无插件行（跳过）');
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const p of PLUGINS) delete pkg.dependencies[p.id];
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + NL);
  console.log('[plugins] 已移除 package.json 依赖（node_modules 请手动清理）');
} else {
  let patch = readFileSync(patchFile, 'utf8');
  if (patch.includes('dsh-deep-ui') || patch.includes('dsh-remote')) {
    console.log('[plugins] cordis.patch.yml 已包含插件（跳过写入）');
  } else if (patch.trim() === '[]' || patch.trim().startsWith('#') && patch.trim().endsWith('[]')) {
    // 空占位 patch（可能带注释）：去掉 [] 占位行后写入插件块
    const kept = patch.split(NL).filter((l) => l.trim() !== '[]').join(NL).trimEnd();
    writeFileSync(patchFile, kept + NL + insertBlock.trimStart());
    console.log('[plugins] 已写入 cordis.patch.yml');
  } else {
    patch = patch.replace(/\s+$/, '') + insertBlock;
    writeFileSync(patchFile, patch);
    console.log('[plugins] 已写入 cordis.patch.yml');
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const p of PLUGINS) {
    const abs = join(REPO, p.dir);
    if (!existsSync(join(abs, 'package.json'))) fail('插件包不存在: ' + abs);
    pkg.dependencies[p.id] = 'file:' + abs;
  }
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + NL);
  console.log('[plugins] 已写入 package.json 依赖');
  console.log('[plugins] 在 profile 目录执行 pnpm install …');
  execSync('pnpm install', { cwd: profileDir, stdio: 'inherit' });
  console.log('');
  console.log('[plugins] 完成 ✅ 插件已接入 profile「' + profile + '」：');
  for (const p of PLUGINS) console.log('  - ' + p.id + '（' + p.desc + '）');
  console.log('');
  console.log('  重启 harness（或重启桌面端 DeepSeek Harness UI）后生效。');
  console.log('  卸载：pnpm plugins:install --remove');
}
