/**
 * prompt-loader.ts — 从 prompts/ 目录加载用户可覆盖的 prompt 模板
 *
 * 文件格式：Markdown，--- 分隔符之前是元数据说明，之后是实际 prompt 内容。
 * 模板变量用 {var_name} 表示，由调用方传入 vars 做替换。
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 从 {personaDir}/prompts/{name}.md 加载 prompt 模板。
 * - 取 --- 分隔符之后的内容（如果有）
 * - 对 vars 做模板变量替换
 * - 文件不存在或为空时返回 undefined
 */
export function loadPrompt(
  personaDir: string,
  name: string,
  vars: Record<string, string> = {},
): string | undefined {
  const filePath = join(personaDir, 'prompts', `${name}.md`);
  if (!existsSync(filePath)) return undefined;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    // Extract content after the last --- separator
    const parts = raw.split(/^---$/m);
    let content = parts.length > 1 ? parts.slice(1).join('---').trim() : raw.trim();

    if (!content) return undefined;

    // Template variable substitution
    for (const [key, value] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }

    return content;
  } catch {
    return undefined;
  }
}


/**
 * 解析 cron job message 中的文件引用。
 * 如果 message 以 @ 开头，视为文件引用（相对于 personaDir），读取文件内容。
 * 否则原样返回。
 */
export function resolveCronMessage(
  personaDir: string,
  message: string,
  vars: Record<string, string> = {},
): string {
  if (!message.startsWith('@')) {
    // Direct message — still do variable substitution
    let result = message;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }

  const refPath = message.slice(1).trim();
  const filePath = join(personaDir, refPath);
  if (!existsSync(filePath)) {
    console.warn(`[prompt-loader] Cron message file not found: ${filePath}`);
    return message;
  }

  try {
    let content = readFileSync(filePath, 'utf-8');
    // Strip header (everything before ---)
    const parts = content.split(/^---$/m);
    if (parts.length > 1) content = parts.slice(1).join('---').trim();

    for (const [key, value] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return content;
  } catch {
    return message;
  }
}
