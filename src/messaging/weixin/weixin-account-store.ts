import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { normalizeAccountId } from './weixin-text.js';

export interface WeixinAccount {
  id: string;
  token: string;
  baseUrl: string;
  userId: string;
  savedAt: string;
}

interface AccountIndex {
  accounts: string[];
}

export class WeixinAccountStore {
  private stateDir: string;
  private accountsDir: string;
  private indexPath: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.accountsDir = join(stateDir, 'accounts');
    this.indexPath = join(stateDir, 'accounts.json');
  }

  private ensureDirs(): void {
    mkdirSync(this.accountsDir, { recursive: true });
  }

  listAccounts(): WeixinAccount[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      const index = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as AccountIndex;
      return index.accounts
        .map(id => this.getAccount(id))
        .filter((a): a is WeixinAccount => a !== null);
    } catch {
      return [];
    }
  }

  getAccount(id: string): WeixinAccount | null {
    const path = join(this.accountsDir, `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as {
        token: string;
        baseUrl: string;
        userId: string;
        savedAt: string;
      };
      return { id, ...data };
    } catch {
      return null;
    }
  }

  saveAccount(account: WeixinAccount): void {
    this.ensureDirs();

    const filePath = join(this.accountsDir, `${account.id}.json`);
    const data = JSON.stringify({
      token: account.token,
      baseUrl: account.baseUrl,
      userId: account.userId,
      savedAt: account.savedAt,
    }, null, 2);
    writeFileSync(filePath, data, { mode: 0o600 });
    chmodSync(filePath, 0o600);

    const index = this.loadIndex();
    if (!index.accounts.includes(account.id)) {
      index.accounts.push(account.id);
      writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    }
  }

  saveAccountFromLogin(
    ilinkBotId: string,
    token: string,
    baseUrl: string,
    userId: string,
  ): WeixinAccount {
    const id = normalizeAccountId(ilinkBotId);
    const account: WeixinAccount = {
      id,
      token,
      baseUrl,
      userId,
      savedAt: new Date().toISOString(),
    };
    this.saveAccount(account);
    return account;
  }

  private loadIndex(): AccountIndex {
    if (!existsSync(this.indexPath)) return { accounts: [] };
    try {
      return JSON.parse(readFileSync(this.indexPath, 'utf-8')) as AccountIndex;
    } catch {
      return { accounts: [] };
    }
  }
}
