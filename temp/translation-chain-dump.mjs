#!/usr/bin/env node
/**
 * 根目录入口：转发到 local-agent-service/scripts/translation-chain-dump.mjs
 * 用法同子脚本；需要本地已安装 tsx（local-agent-service/node_modules）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const tsx = path.join(root, 'local-agent-service', 'node_modules', '.bin', 'tsx');
const script = path.join(root, 'local-agent-service', 'scripts', 'translation-chain-dump.mjs');
const result = spawnSync(tsx, [script, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
