/**
 * 检查 web-v2/dist 是否存在且不比源码旧,缺失或过时则自动 `vite build`。
 *
 * 启动时由 src/index.ts 调用,以保证 V2 默认前端总能开箱即用。
 * 用户在本地改了 web-v2/src/** 后无需手动 `bun run build`——下一次 `bun run dev` 会自动触发。
 *
 * 设计取舍:
 * - 不监听 fs 变化(不是 dev server),只在启动时检查一次。
 * - mtime 比对覆盖 src/、index.html、vite.config.ts、package.json 这几类影响构建产物的输入。
 * - build 失败不阻断启动 —— 控制台会报错,/ 路由会返回 500。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

const WEB_V2_ROOT = resolve(import.meta.dir, '..', 'web-v2');
const DIST_DIR = join(WEB_V2_ROOT, 'dist');
const DIST_INDEX = join(DIST_DIR, 'index.html');
const DEPLOY_ENV = join(WEB_V2_ROOT, '.deploy.env');
const SRC_DIR = join(WEB_V2_ROOT, 'src');
// 影响构建结果的额外输入 — package.json / vite.config / 入口 html / Tailwind 配置等
const EXTRA_INPUTS = ['index.html', 'vite.config.ts', 'package.json', 'tsconfig.json', 'tsconfig.app.json'];

/** 递归找出目录下所有文件的最大 mtime(ms),用作"源码最新一次修改时间" */
function maxMtime(dir: string): number {
  let max = 0;
  if (!existsSync(dir)) return max;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const name of readdirSync(cur)) {
      // node_modules 和 dist 不算源码输入;.DS_Store 之类系统垃圾跳过
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else {
        if (st.mtimeMs > max) max = st.mtimeMs;
      }
    }
  }
  return max;
}

/** 检查 dist 是否需要重建。返回原因(字符串)或 null(无需重建) */
function needsRebuild(): string | null {
  if (!existsSync(DIST_INDEX)) return 'dist/index.html 不存在';
  const distMtime = statSync(DIST_INDEX).mtimeMs;
  const srcMtime = maxMtime(SRC_DIR);
  if (srcMtime > distMtime) return `src/ 比 dist 新 (${new Date(srcMtime).toISOString()})`;
  for (const name of EXTRA_INPUTS) {
    const p = join(WEB_V2_ROOT, name);
    if (existsSync(p) && statSync(p).mtimeMs > distMtime) {
      return `${name} 比 dist 新`;
    }
  }
  return null;
}

/** 在 web-v2 下跑 `bun run build`,流式打印输出 */
function runBuild(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', 'build'], {
      cwd: WEB_V2_ROOT,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error('[ensure-web-v2-dist] 启动 bun 失败:', err.message);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** 如果存在 .deploy.env，rsync dist 到远程服务器（fire-and-forget，不阻塞启动） */
function deployDist(): void {
  if (!existsSync(DEPLOY_ENV)) return;
  const env: Record<string, string> = {};
  for (const line of readFileSync(DEPLOY_ENV, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const host = env['DEPLOY_HOST'];
  const path = env['DEPLOY_PATH'] || '/var/www/pshell-ui';
  if (!host) return;

  console.log(`[ensure-web-v2-dist] deploying to ${host}:${path} ...`);
  const child = spawn('rsync', ['-az', '--delete', `${DIST_DIR}/`, `${host}:${path}/`], {
    stdio: 'inherit',
  });
  child.on('close', (code) => {
    if (code === 0) {
      console.log(`[ensure-web-v2-dist] ✓ deploy 完成`);
    } else {
      console.error(`[ensure-web-v2-dist] ✗ deploy 失败 (exit=${code})`);
    }
  });
  child.on('error', (err) => {
    console.error(`[ensure-web-v2-dist] ✗ deploy 启动失败:`, err.message);
  });
}

/**
 * 启动时调用一次。返回 true 表示 dist 可用(可能本来就在,也可能刚 build 完);
 * 返回 false 表示 build 失败 —— 调用方可以决定是否继续启动(默认继续,/ 会 500)。
 */
export async function ensureWebV2Dist(): Promise<boolean> {
  const reason = needsRebuild();
  if (!reason) return true;

  console.log(`[ensure-web-v2-dist] 需要构建 web-v2:${reason},运行 bun run build...`);
  const start = Date.now();
  const code = await runBuild();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (code === 0) {
    console.log(`[ensure-web-v2-dist] ✓ web-v2 构建完成 (${elapsed}s)`);
    deployDist();
    return true;
  }
  console.error(`[ensure-web-v2-dist] ✗ web-v2 构建失败 (exit=${code}, ${elapsed}s) — / 会返回 500`);
  return false;
}

// 允许独立调用:`bun scripts/ensure-web-v2-dist.ts`
if (import.meta.main) {
  ensureWebV2Dist().then((ok) => process.exit(ok ? 0 : 1));
}
