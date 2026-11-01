#!/usr/bin/env node
/**
 * 对齐历史审校建议的应用状态（默认只读）。
 *
 * 背景：早期版本的审校流程只在片段带 must_fix 时才把随附的文风建议记为已应用，
 * 纯文风片段虽然采用了候选译文（建议文本已经进了正文），落库状态却仍是 pending，
 * 界面会一直把已经生效的建议列成待处理。
 *
 * 判据：style 类、status 仍为 pending、且 proposedTranslation 与当前已采纳译文逐字相同——
 * 三者同时成立才说明建议已经落地，只差记账。must_fix 没有独立的候选译文，不参与对齐。
 *
 * 用法（在 local-agent-service 目录）：
 *   node scripts/align-review-finding-status.mjs                 # 扫全部项目，只打印
 *   node scripts/align-review-finding-status.mjs --apply         # 扫描并写回（先备份库文件）
 *   node scripts/align-review-finding-status.mjs --db <path>     # 只处理指定项目库
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbArgIndex = args.indexOf('--db');
const dataDir = process.env.LOCAL_AGENT_DATA_DIR
  ? path.resolve(process.env.LOCAL_AGENT_DATA_DIR)
  : path.join(homedir(), '.vocal-saga-local-agent');
const documentsDir = path.join(dataDir, 'documents');

function projectDatabases() {
  if (dbArgIndex >= 0) return [path.resolve(args[dbArgIndex + 1])];
  if (!existsSync(documentsDir)) return [];
  return readdirSync(documentsDir)
    .map((name) => path.join(documentsDir, name, 'project.sqlite'))
    .filter((file) => existsSync(file) && statSync(file).isFile());
}

/** 收集可对齐的建议：返回待改写记录与统计。 */
function scanDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  const pending = db.prepare(
    "SELECT finding_id, run_id, segment_id, finding_json FROM review_findings " +
    "WHERE status = 'pending' AND category = 'style'",
  ).all();
  const acceptedStmt = db.prepare(
    'SELECT translation_text FROM translation_results ' +
    'WHERE source_revision_id = ? AND segment_id = ? AND source_hash = ? AND accepted = 1 ' +
    'ORDER BY COALESCE(accepted_at, created_at) DESC, rowid DESC LIMIT 1',
  );
  const runStmt = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?');
  const hashStmt = db.prepare(
    'SELECT source_hash FROM run_segments WHERE run_id = ? AND segment_id = ?',
  );
  const alignable = [];
  for (const row of pending) {
    let finding;
    try {
      finding = JSON.parse(row.finding_json);
    } catch {
      continue;
    }
    const proposed = typeof finding.proposedTranslation === 'string' ? finding.proposedTranslation.trim() : '';
    if (!proposed) continue;
    const run = runStmt.get(row.run_id);
    const segment = hashStmt.get(row.run_id, row.segment_id);
    if (!run || !segment) continue;
    const accepted = acceptedStmt.get(run.source_revision_id, row.segment_id, segment.source_hash);
    if (String(accepted?.translation_text || '').trim() !== proposed) continue;
    alignable.push({ findingId: row.finding_id, runId: row.run_id, segmentId: row.segment_id, finding });
  }
  db.close();
  return alignable;
}

/** 写回应用状态；同一事务内完成，失败整体回滚。 */
function applyDatabase(dbPath, rows) {
  const backup = dbPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(dbPath, backup);
  const db = new DatabaseSync(dbPath);
  const update = db.prepare(
    "UPDATE review_findings SET status = 'applied', finding_json = ? " +
    "WHERE finding_id = ? AND status = 'pending'",
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const finding = { ...row.finding, applicationStatus: 'applied', applicationMethod: 'automatic-review-adoption' };
      update.run(JSON.stringify(finding), row.findingId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已回滚 */ }
    db.close();
    throw error;
  }
  db.close();
  return backup;
}

const databases = projectDatabases();
if (!databases.length) {
  console.log('没有找到项目数据库：' + documentsDir);
  process.exit(0);
}
let total = 0;
for (const dbPath of databases) {
  const rows = scanDatabase(dbPath);
  total += rows.length;
  const label = path.basename(path.dirname(dbPath));
  if (!rows.length) {
    console.log(`· ${label}：无需对齐`);
    continue;
  }
  const byRun = new Map();
  for (const row of rows) byRun.set(row.runId, (byRun.get(row.runId) || 0) + 1);
  const detail = Array.from(byRun.entries()).map(([runId, count]) => `${runId.slice(0, 8)}×${count}`).join(' · ');
  if (apply) {
    const backup = applyDatabase(dbPath, rows);
    console.log(`· ${label}：已对齐 ${rows.length} 条（${detail}），备份 ${path.basename(backup)}`);
  } else {
    console.log(`· ${label}：可对齐 ${rows.length} 条（${detail}）`);
  }
}
console.log(apply
  ? `完成：共对齐 ${total} 条。`
  : `共 ${total} 条可对齐；加 --apply 执行写回。`);
