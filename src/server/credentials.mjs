import { spawn } from 'node:child_process';

const DEFAULT_SERVICE = 'com.reader.local-first.ai';
const DEFAULT_ACCOUNT = 'api-key';

function credentialError(message, status = 503) {
  return Object.assign(new Error(message), { status, expected: true });
}

async function runSecurity(args, { input = '', timeoutMs = 20_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let total = 0;
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total <= 128 * 1024) target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    const timer = setTimeout(() => { child.kill(); reject(credentialError('macOS Keychain 操作超时', 504)); }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: Number(code), stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() });
    });
    child.stdin.end(input);
  });
}

export class MacOSKeychainCredentialStore {
  constructor({
    platform = process.platform,
    service = DEFAULT_SERVICE,
    account = DEFAULT_ACCOUNT,
    label = 'Reader AI API Key',
    secretName = 'AI 密钥'
  } = {}) {
    this.platform = platform;
    this.service = service;
    this.account = account;
    this.label = label;
    this.secretName = secretName;
  }

  describe() {
    return { backend: this.platform === 'darwin' ? 'macos-keychain' : 'environment-only', writable: this.platform === 'darwin' };
  }

  async get() {
    if (this.platform !== 'darwin') return null;
    const result = await runSecurity(['find-generic-password', '-a', this.account, '-s', this.service, '-w']);
    if (result.code === 0) return result.stdout;
    if (result.code === 44 || /could not be found/i.test(result.stderr)) return null;
    throw credentialError(`无法读取 macOS Keychain 中的${this.secretName}`);
  }

  async set(secret) {
    if (this.platform !== 'darwin') throw credentialError('当前平台不能写入 macOS Keychain', 501);
    const value = String(secret || '');
    if (!value || value.length > 8192 || value.trim() !== value || /[\r\n\0]/.test(value)) throw credentialError(`${this.secretName}长度或格式无效`, 400);
    const result = await runSecurity(['add-generic-password', '-U', '-a', this.account, '-s', this.service, '-l', this.label, '-w'], { input: `${value}\n` });
    if (result.code !== 0) throw credentialError(`${this.secretName}未能写入 macOS Keychain`);
  }

  async delete() {
    if (this.platform !== 'darwin') return false;
    const result = await runSecurity(['delete-generic-password', '-a', this.account, '-s', this.service]);
    if (result.code === 0) return true;
    if (result.code === 44 || /could not be found/i.test(result.stderr)) return false;
    throw credentialError(`无法从 macOS Keychain 移除${this.secretName}`);
  }
}
