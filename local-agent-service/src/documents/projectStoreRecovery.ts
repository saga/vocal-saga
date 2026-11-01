/**
 * 服务重启后的状态恢复。
 *
 * 进程被杀时可能留下：状态为 running 的片段、没有终态事件的 Run/Context Graph 记录，
 * 以及停在 awaiting_acceptance 的最终化流程。这里把它们全部收敛到明确状态，
 * 保证重启后看到的状态与磁盘一致，且同一轮最终化可以幂等重放。
 */
import { logWarn } from '../log.ts';
import { isoNow, parseJson } from './documentStoreUtils.ts';
import { type DocumentProjectStore } from './projectStore.ts';
import { mergeTranslationContextDeltasIntoMemory } from './translationContextDelta.ts';

/**
 * 服务启动时恢复被中断的运行。
 * 将 running 片段归一化为 pending，根据终态事件或缺失终态事件把 Run/Context Graph
 * 收敛到明确状态，并恢复所有 awaiting_acceptance 的最终化流程。
 */
export function recoverInterruptedRuns(store: DocumentProjectStore): void {
  const rows = store.catalogDb().prepare('SELECT project_id FROM document_projects WHERE archived = 0').all() as Array<{ project_id: string }>;
  for (const row of rows) {
    try {
      const db = store.openProjectDb(row.project_id);
      db.exec('BEGIN IMMEDIATE');
      const now = isoNow();
      let recoveredTranslations = 0;
      let recoveredContextGraphs = 0;

      // 先把被打断的片段 worker 归一，再写恢复事件。终态计数必须描述
      // 恢复之后的持久状态，而不是重启前 worker 的状态。
      db.prepare("UPDATE run_segments SET status = 'pending', updated_at = ? WHERE status = 'running'").run(now);
      const runSegmentCounts = (runId: string): Record<string, number> => {
        const rows = db.prepare(
          'SELECT status, COUNT(*) AS count FROM run_segments WHERE run_id = ? GROUP BY status',
        ).all(runId) as Array<{ status: string; count: number }>;
        const counts = Object.fromEntries(rows.map((item) => [item.status, Number(item.count)]));
        return {
          total: rows.reduce((sum, item) => sum + Number(item.count), 0),
          ...counts,
        };
      };

      // 终态事件本身就是状态转移的一部分。若它已经存在，
      // 就按这条事件去对齐记录，不要再造一个自相矛盾的第二个结局。
      const translationRuns = db.prepare(
        "SELECT run_id FROM translation_runs WHERE status IN ('running','queued')"
      ).all() as Array<{ run_id: string }>;
      for (const run of translationRuns) {
        const terminal = db.prepare(
          "SELECT event_type, payload_json, created_at FROM project_events WHERE run_id = ? AND event_type IN ('run.finished','run.failed','run.completed','run.partial','run.cancelled','run.paused','run.awaiting_acceptance') ORDER BY event_id DESC LIMIT 1"
        ).get(run.run_id) as { event_type: string; payload_json?: string; created_at?: string } | undefined;

        if (terminal) {
          const payload = parseJson<Record<string, any>>(terminal.payload_json, {});
          const reported = String(payload.status || '');
          const eventStatus = terminal.event_type === 'run.finished' ? reported : terminal.event_type.slice('run.'.length);
          const status = ['completed', 'failed', 'partial', 'cancelled', 'paused', 'awaiting_acceptance'].includes(eventStatus)
            ? eventStatus : 'failed';
          const error = status === 'completed' ? null
            : String(payload.error || '服务重启时根据已有终态事件恢复运行状态').slice(0, 2000);
          db.prepare(
            "UPDATE translation_runs SET status = ?, finished_at = COALESCE(finished_at, ?), error = ? WHERE run_id = ? AND status IN ('running','queued')"
          ).run(status, terminal.created_at || now, error, run.run_id);
          continue;
        }

        const error = '服务重启中断了这次运行；可在 Agent 面板恢复或放弃';
        const changed = db.prepare(
          "UPDATE translation_runs SET status = 'failed', finished_at = COALESCE(finished_at, ?), error = ? WHERE run_id = ? AND status IN ('running','queued')"
        ).run(now, error, run.run_id);
        if (changed.changes > 0) {
          store.appendEvent(row.project_id, run.run_id, 'run.finished', {
            status: 'failed', error, recovery: 'service-restart',
            counts: runSegmentCounts(run.run_id),
          });
          recoveredTranslations++;
        }
      }

      // 迁移旧版本误留在 paused 的重启孤儿。
      const legacyPausedRuns = db.prepare(
        "SELECT run_id FROM translation_runs WHERE status = 'paused' AND error = '服务重启后等待恢复'"
      ).all() as Array<{ run_id: string }>;
      for (const run of legacyPausedRuns) {
        const terminal = db.prepare(
          "SELECT 1 FROM project_events WHERE run_id = ? AND event_type IN ('run.finished','run.failed','run.completed','run.partial','run.cancelled','run.awaiting_acceptance') LIMIT 1"
        ).get(run.run_id);
        const error = '服务重启中断了这次运行；可在 Agent 面板恢复或放弃';
        db.prepare(
          "UPDATE translation_runs SET status = 'failed', finished_at = COALESCE(finished_at, ?), error = ? WHERE run_id = ? AND status = 'paused'"
        ).run(now, error, run.run_id);
        if (!terminal) {
          store.appendEvent(row.project_id, run.run_id, 'run.finished', {
            status: 'failed', error, recovery: 'legacy-restart-orphan',
            counts: runSegmentCounts(run.run_id),
          });
          recoveredTranslations++;
        }
      }
      // 旧终态行也要补：老恢复代码改了库里的状态却跳过终态事件，
      // 轨迹因此只剩阶段事件、永远收不了尾。
      const terminalTranslationRows = db.prepare(
        "SELECT r.run_id, r.status, r.error FROM translation_runs r " +
        "WHERE r.status IN ('failed','completed','partial','cancelled','awaiting_acceptance') " +
        "AND NOT EXISTS (SELECT 1 FROM project_events e WHERE e.run_id = r.run_id " +
        "AND e.event_type IN ('run.finished','run.failed','run.completed','run.partial','run.cancelled','run.awaiting_acceptance'))"
      ).all() as Array<{ run_id: string; status: string; error?: string | null }>;
      for (const run of terminalTranslationRows) {
        store.appendEvent(row.project_id, run.run_id, 'run.finished', {
          status: run.status,
          error: run.error || undefined,
          recovery: 'terminal-event-backfill',
          counts: runSegmentCounts(run.run_id),
        });
        recoveredTranslations++;
      }

      // 写 Run 恢复事件之前，running 的片段已经归一成 pending 了。

      const graphSchemaExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_graph_runs'"
      ).get();
      if (graphSchemaExists) {
        const graphRuns = db.prepare(
          "SELECT run_id FROM context_graph_runs WHERE status IN ('running','queued')"
        ).all() as Array<{ run_id: string }>;
        for (const run of graphRuns) {
          const terminal = db.prepare(
            "SELECT event_type, payload_json, created_at FROM project_events WHERE run_id = ? AND event_type IN ('context-graph.completed','context-graph.failed') ORDER BY event_id DESC LIMIT 1"
          ).get(run.run_id) as { event_type: string; payload_json?: string; created_at?: string } | undefined;

          if (terminal?.event_type === 'context-graph.completed') {
            db.prepare(
              "UPDATE context_graph_runs SET status = 'completed', phase = 'completed', finished_at = COALESCE(finished_at, ?), error = NULL WHERE run_id = ? AND status IN ('running','queued')"
            ).run(terminal.created_at || now, run.run_id);
            continue;
          }
          if (terminal?.event_type === 'context-graph.failed') {
            const payload = parseJson<Record<string, any>>(terminal.payload_json, {});
            db.prepare(
              "UPDATE context_graph_runs SET status = 'failed', phase = 'failed', finished_at = COALESCE(finished_at, ?), error = COALESCE(error, ?) WHERE run_id = ? AND status IN ('running','queued')"
            ).run(terminal.created_at || now, String(payload.error || '全书预处理已失败'), run.run_id);
            continue;
          }

          const error = '服务重启后分析中断；请重新运行 context-analyze';
          const changed = db.prepare(
            "UPDATE context_graph_runs SET status = 'failed', phase = 'failed', error = ?, finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND status IN ('running','queued')"
          ).run(error, now, run.run_id);
          if (changed.changes > 0) {
            store.appendEvent(row.project_id, run.run_id, 'context-graph.failed', {
              error, recovery: 'service-restart', reason: 'process-interrupted',
            });
            recoveredContextGraphs++;
          }
        }

        const terminalGraphRows = db.prepare(
          "SELECT run_id, status, progress_json, error FROM context_graph_runs r " +
          "WHERE status IN ('completed','failed') " +
          "AND NOT EXISTS (SELECT 1 FROM project_events e WHERE e.run_id = r.run_id " +
          "AND e.event_type IN ('context-graph.completed','context-graph.failed'))"
        ).all() as Array<{ run_id: string; status: string; progress_json?: string; error?: string | null }>;
        for (const run of terminalGraphRows) {
          const progress = parseJson<Record<string, any>>(run.progress_json, {});
          if (run.status === 'completed') {
            store.appendEvent(row.project_id, run.run_id, 'context-graph.completed', {
              sampleCount: progress.sampleCount ?? 0,
              chapterCount: progress.chapterCount ?? 0,
              characterCount: progress.characterCount ?? 0,
              entityCount: progress.entityCount ?? 0,
              relationshipCount: progress.relationshipCount ?? 0,
              canonicalNameMappingCount: progress.canonicalNameMappingCount ?? 0,
              invalidEvidenceCount: progress.invalidEvidenceCount ?? 0,
              sourceLang: progress.sourceLang,
              targetLang: progress.targetLang,
              analysisVersion: progress.analysisVersion,
              recovery: 'terminal-event-backfill',
            });
          } else {
            store.appendEvent(row.project_id, run.run_id, 'context-graph.failed', {
              error: run.error || '全书预处理已失败（旧记录缺少终态事件）',
              recovery: 'terminal-event-backfill',
            });
          }
          recoveredContextGraphs++;
        }
      }
      db.exec('COMMIT');

      // 进程可能在 finishRun 落盘 awaiting_acceptance 之后、执行器提交记忆增量
      // 与采纳候选之前停掉。启动时把这步收尾补完；它幂等，
      // 且在补完之前会继续挡住新的 Run。
      const awaitingAcceptance = db.prepare(
        "SELECT run_id FROM translation_runs WHERE status = 'awaiting_acceptance' ORDER BY created_at, rowid"
      ).all() as Array<{ run_id: string }>;
      for (const pending of awaitingAcceptance) {
        try {
          store.recoverAwaitingAcceptanceRun(row.project_id, pending.run_id);
        } catch (recoveryError) {
          logWarn('document-projects', 'pending acceptance recovery failed · project=' + row.project_id +
            ' · run=' + pending.run_id + ' · ' +
            (recoveryError instanceof Error ? recoveryError.message : String(recoveryError)));
        }
      }

      if (recoveredTranslations || recoveredContextGraphs) {
        logWarn('document-projects', 'recovered interrupted runs · project=' + row.project_id +
          ' · translation=' + recoveredTranslations + ' · context-graph=' + recoveredContextGraphs);
      }
    } catch (error) {
      try { store.projectDbs.get(row.project_id)?.exec('ROLLBACK'); } catch { /* no active transaction */ }
      logWarn('document-projects', 'recovery check failed for ' + row.project_id + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
}

/**
 * 服务重启后恢复处于 awaiting_acceptance 的 Run。
 * 先在事务内完成文学记忆增量合并（仅 literary 模式且原文未变化），再采纳候选译文，保证最终化幂等。
 */
export function recoverAwaitingAcceptanceRun(store: DocumentProjectStore, projectId: string, runId: string): void {
  const db = store.openProjectDb(projectId);
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare(
      "SELECT source_revision_id, translation_mode FROM translation_runs WHERE run_id = ? AND status = 'awaiting_acceptance'"
    ).get(runId) as { source_revision_id?: string; translation_mode?: string } | undefined;
    if (!run) {
      db.exec('COMMIT');
      return;
    }
    const currentSource = db.prepare("SELECT value FROM project_meta WHERE key = 'current_source_revision_id'").get() as { value?: string } | undefined;
    if (run.source_revision_id === currentSource?.value && run.translation_mode === 'literary') {
      const deltas = store.listTranslationContextDeltas(projectId, runId)
        .map((item: any) => item.delta);
      const currentMemory = store.getCurrentLiteraryMemory(projectId);
      const merged = mergeTranslationContextDeltasIntoMemory(currentMemory.memory, deltas);
      if (merged.changed) {
        const saved = store.saveLiteraryMemory(projectId, merged.memory);
        store.appendEvent(projectId, runId, 'translation.context-memory.persisted', {
          memoryRevisionId: saved.memoryRevisionId,
          fingerprint: saved.fingerprint,
          sourceRevisionId: run.source_revision_id,
          deltaBatchCount: deltas.length,
          ...merged.summary,
          recovery: 'service-restart-finalization',
        });
      }
    } else if (run.source_revision_id !== currentSource?.value) {
      store.appendEvent(projectId, runId, 'translation.context-memory.skipped', {
        reason: 'source-revision-changed-during-recovery',
        runSourceRevisionId: run.source_revision_id,
        currentSourceRevisionId: currentSource?.value || null,
        recovery: 'service-restart-finalization',
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }

  const finished = store.acceptCandidates(projectId, runId);
  store.appendEvent(projectId, runId, 'run.finalization.recovered', {
    status: finished.status,
    counts: finished.counts || {},
    recovery: 'service-restart-finalization',
  });
}
