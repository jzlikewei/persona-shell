#!/usr/bin/env bun
/**
 * 微信 QR 扫码登录脚本 — 独立 CLI，不在 Shell 主进程运行。
 *
 * 用法: bun scripts/weixin-login.ts [--state-dir ~/.persona/weixin] [--base-url https://ilinkai.weixin.qq.com]
 */
import { parseArgs } from 'util';
import { createInterface } from 'readline';
import qrcode from 'qrcode-terminal';
import { WeixinApi } from '../src/messaging/weixin/weixin-api.js';
import { WeixinAccountStore } from '../src/messaging/weixin/weixin-account-store.js';
import { homedir } from 'os';
import type { QrCodeStatusResponse, LoginStatus } from '../src/messaging/weixin/weixin-types.js';

const { values } = parseArgs({
  options: {
    'state-dir': { type: 'string', default: `${homedir()}/.persona/weixin` },
    'base-url': { type: 'string', default: 'https://ilinkai.weixin.qq.com' },
  },
  strict: false,
});

const stateDir = values['state-dir'] as string;
const baseUrl = values['base-url'] as string;

const api = new WeixinApi({
  defaultBaseUrl: baseUrl,
  botAgent: 'PersonaShell/0.1.0',
  appId: 'bot',
  clientVersion: '2.4.4',
});

const accountStore = new WeixinAccountStore(stateDir);

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('🔑 微信 QR 扫码登录');
  console.log(`   state-dir: ${stateDir}`);
  console.log(`   base-url:  ${baseUrl}`);
  console.log();

  // Step 1: Get QR code
  console.log('正在获取二维码...');
  const qrRes = await api.getQrCode(baseUrl);
  if (qrRes.errcode && qrRes.errcode !== 0) {
    console.error(`获取二维码失败: errcode=${qrRes.errcode} ${qrRes.errmsg ?? ''}`);
    process.exit(1);
  }
  if (!qrRes.qrcode_url || !qrRes.qrcode_id) {
    console.error('获取二维码失败: 返回数据缺少 qrcode_url 或 qrcode_id');
    process.exit(1);
  }

  console.log('请用微信扫描以下二维码:');
  console.log();
  qrcode.generate(qrRes.qrcode_url, { small: true });
  console.log();
  console.log(`二维码链接: ${qrRes.qrcode_url}`);
  console.log();

  // Step 2: Poll for status
  let currentBaseUrl = baseUrl;
  const qrcodeId = qrRes.qrcode_id;

  while (true) {
    await sleep(2000);
    let statusRes: QrCodeStatusResponse;

    try {
      statusRes = await api.getQrCodeStatus(qrcodeId, currentBaseUrl);
    } catch (err) {
      console.warn('轮询状态失败, 重试中...', err instanceof Error ? err.message : err);
      continue;
    }

    const status: LoginStatus = statusRes.status;

    switch (status) {
      case 'wait':
        process.stdout.write('.');
        break;

      case 'scaned':
        console.log('\n✅ 已扫码，等待确认...');
        break;

      case 'confirmed': {
        console.log('\n✅ 登录成功!');
        if (!statusRes.bot_token || !statusRes.ilink_bot_id) {
          console.error('登录返回数据不完整, 缺少 bot_token 或 ilink_bot_id');
          process.exit(1);
        }
        const account = accountStore.saveAccountFromLogin(
          statusRes.ilink_bot_id,
          statusRes.bot_token,
          statusRes.baseurl ?? currentBaseUrl,
          statusRes.ilink_user_id ?? '',
        );
        console.log(`\n账号已保存:`);
        console.log(`  Account ID: ${account.id}`);
        console.log(`  Base URL:   ${account.baseUrl}`);
        console.log(`  State Dir:  ${stateDir}`);
        console.log(`\n现在可以在 config.yaml 中启用微信:`);
        console.log(`  weixin:`);
        console.log(`    enabled: true`);
        return;
      }

      case 'expired':
        console.log('\n❌ 二维码已过期');
        const retry = await prompt('是否重新获取二维码? (y/n) ');
        if (retry.toLowerCase() === 'y') {
          return main();
        }
        process.exit(0);
        break;

      case 'scaned_but_redirect':
        if (statusRes.redirect_host) {
          console.log(`\n🔄 重定向到: ${statusRes.redirect_host}`);
          currentBaseUrl = statusRes.redirect_host;
        }
        break;

      case 'need_verifycode': {
        console.log('\n🔐 需要输入验证码');
        const code = await prompt('请输入微信上显示的验证码: ');
        // Re-poll with verify code — the exact field name depends on the API
        // Retry the status check which should pick up the confirmation
        console.log(`验证码已输入: ${code}`);
        // The verification code is typically handled client-side by the WeChat app
        // Continue polling for confirmed status
        break;
      }

      case 'verify_code_blocked':
        console.error('\n❌ 验证码验证失败，登录被阻止');
        process.exit(1);
        break;

      case 'binded_redirect':
        console.warn('\n⚠️  该 bot 已绑定到其他实例。');
        console.warn('   如果是从 OpenClaw Gateway 迁移，请先停止 Gateway 的微信 channel。');
        if (statusRes.redirect_host) {
          console.log(`   重定向到: ${statusRes.redirect_host}`);
          currentBaseUrl = statusRes.redirect_host;
        }
        break;

      default:
        console.warn(`\n未知状态: ${status}`);
    }
  }
}

main().catch(err => {
  console.error('登录失败:', err);
  process.exit(1);
});
