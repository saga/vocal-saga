/**
 * 命令行入口：先加载同一份本地 .env，再导入会读 process.env 的模块。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = process.env.LOCAL_AGENT_ENV_FILE?.trim()
  ? path.resolve(process.env.LOCAL_AGENT_ENV_FILE)
  : path.join(serviceDir, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const { runDocumentCli } = await import('./cli.ts');
await runDocumentCli();
