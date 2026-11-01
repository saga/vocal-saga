/**
 * A 方案的整本单发分析与文风字段定向补全。
 *
 * 两者都是一次结构化调用加一次进度落地；区别是补全只针对空掉的文风字段，
 * 补完仍为空就整轮失败，不拿空文风冒充完成。
 */

import { type DatabaseSync } from 'node:sqlite';
import { ANALYSIS_TIMEOUT_MS } from '../config.ts';
import { type parseAgentModel } from '../json.ts';
import { getCodeBuddyTaskProfile } from '../agents/taskProfiles.ts';
import { runAgentStructured } from '../agents/runner.ts';
import { formatTurnUsageLog } from '../agents/usage.ts';
import { logInfo, logWarn } from '../log.ts';
import {
  ANALYSIS_SCHEMA,
  DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
  type Segment,
} from './contextGraphSchema.ts';
import {
  patchRunProgress,
  persistWorkflowStageCheckpoint,
  safeText,
  saveMeta,
  uniqueStrings,
  workflowSessionKey,
} from './contextGraphStore.ts';
import {
  buildContextGraphWorkflowPrompt,
  buildContextGraphWorkflowSchema,
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
  type ContextGraphAnalysisStrategy,
} from './contextGraphWorkflow.ts';

/** A 方案：一次结构化调用产出整本图谱；失败即整体失败，不做部分采纳。 */
export async function runSingleShotAnalysis(input: {
  db: DatabaseSync;
  projectId: string;
  revisionId: string;
  runId: string;
  prompt: string;
  agent: ReturnType<typeof parseAgentModel>;
  taskProfile: ReturnType<typeof getCodeBuddyTaskProfile>;
  modelAnalysisStartedAt: number;
}): Promise<Record<string, any>> {
  const { db, projectId, revisionId, runId, prompt, agent, taskProfile, modelAnalysisStartedAt } = input;
  const analysisRun = await runAgentStructured(
    { provider: agent.provider, model: agent.model },
    prompt,
    DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
    ANALYSIS_SCHEMA,
    runId,
    'context-graph:' + projectId + ':' + revisionId + ':' + runId,
    taskProfile,
    { timeoutMs: ANALYSIS_TIMEOUT_MS },
  );
  if (analysisRun.usage) logInfo('context-graph', formatTurnUsageLog(analysisRun.usage));
  const output = analysisRun.result;
  if (!output || Array.isArray(output)) throw new Error('Context Graph 分析返回了非对象结果。');
  const data = output as Record<string, any>;
  patchRunProgress(db, runId, {
    strategy: 'A', workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
    currentStage: null, workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
  });
  return data;
}

/**
 * 文风字段的定向补全：有些 provider 把 schema 当形状提示，仍会返回空字符串。
 * 只补这几个字段，补完仍为空则整轮失败——不拿空文风冒充完成。
 */
export async function completeStyleGuide(input: {
  db: DatabaseSync;
  projectId: string;
  revisionId: string;
  runId: string;
  prompt: string;
  data: Record<string, any>;
  strategy: ContextGraphAnalysisStrategy;
  agent: ReturnType<typeof parseAgentModel>;
  taskProfile: ReturnType<typeof getCodeBuddyTaskProfile>;
  modelAnalysisStartedAt: number;
  sampleIds: Set<string>;
  samples: Segment[];
  workflowSessionId?: string;
}): Promise<{
  styleRepairUsed: boolean;
  styleFieldCoverage: Record<string, boolean>;
  styleRuleCount: number;
  styleAvoidCount: number;
  styleEvidenceCount: number;
}> {
  const { db, projectId, revisionId, runId, prompt, data, strategy, agent, taskProfile, modelAnalysisStartedAt, sampleIds, samples } = input;
  let workflowSessionId = input.workflowSessionId || '';
  const styleDimensions = ['narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue', 'styleDiction'];
  const findMissingStyleFields = (value: Record<string, any>) => [
    ...styleDimensions.filter((field) => !safeText(value[field], 1000)),
    ...(!Array.isArray(value.styleRules) || uniqueStrings(value.styleRules, 24, 240).length === 0 ? ['styleRules'] : []),
  ];
  let missingStyleDimensions = findMissingStyleFields(data);
  let styleRepairUsed = false;
  if (missingStyleDimensions.length) {
    styleRepairUsed = true;
    // Some providers treat a JSON schema as shape guidance and still emit empty strings.
    // Repair only these fields rather than falsely completing a run with an empty style guide.
    logWarn('context-graph', '文风字段为空，启动定向补全 · strategy=' + strategy + ' · fields=' + missingStyleDimensions.join(','));
    const repairStartedAt = Date.now();
    const repairRun = await runAgentStructured(
      { provider: agent.provider, model: agent.model },
      buildContextGraphWorkflowPrompt(
        'style', prompt, data, strategy === 'B' && agent.provider === 'workbuddy' && !!workflowSessionId,
      ) + '\n\n上次结构化响应中的以下字段为空：' + missingStyleDimensions.join('、') +
        '。请重新分析并全部填写这些字段；不能返回空字符串或空规则数组。保持其他字段的证据边界，不要编造原文证据。',
      DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
      buildContextGraphWorkflowSchema(ANALYSIS_SCHEMA, 'style'),
      runId + ':style-repair',
      'context-graph:' + projectId + ':' + revisionId + ':' + runId,
      taskProfile,
      {
        timeoutMs: Math.min(ANALYSIS_TIMEOUT_MS, 5 * 60 * 1000),
        ...(strategy === 'B' && agent.provider === 'workbuddy' ? {
          persistSession: true,
          ...(workflowSessionId ? { sessionId: workflowSessionId } : {}),
          onSessionId: (sessionId: string) => {
            workflowSessionId = sessionId;
            saveMeta(db, revisionId, workflowSessionKey(runId), sessionId);
          },
        } : {}),
      },
    );
    if (!repairRun.result || Array.isArray(repairRun.result)) throw new Error('Context Graph 文风补全返回了非对象结果。');
    const repairedStyle = repairRun.result as Record<string, any>;
    Object.assign(data, repairedStyle);
    missingStyleDimensions = findMissingStyleFields(data);
    if (missingStyleDimensions.length) {
      throw new Error('Context Graph 文风补全后仍缺少有效字段（' + missingStyleDimensions.join('、') +
        '）。本轮未标记为完成；B 方案已保存的其他阶段结果会在重试时复用。');
    }
    if (strategy === 'B') {
      persistWorkflowStageCheckpoint(
        db, revisionId, runId, 'style',
        Object.fromEntries(CONTEXT_GRAPH_WORKFLOW_STAGES[0].fields.map((field) => [field, data[field]])),
        Date.now() - repairStartedAt, sampleIds, samples,
      );
    }
  }
  const styleFieldCoverage = Object.fromEntries(
    styleDimensions.map((field) => [field, !!safeText(data[field], 1000)]),
  ) as Record<string, boolean>;
  const styleRuleCount = uniqueStrings(data.styleRules, 24, 240).length;
  const styleAvoidCount = uniqueStrings(data.styleAvoid, 16, 240).length;
  const styleEvidenceCount = Array.isArray(data.styleEvidence) ? data.styleEvidence.length : 0;
  patchRunProgress(db, runId, {
    workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
    styleRepairUsed, styleFieldCoverage, styleRuleCount, styleAvoidCount, styleEvidenceCount,
  });
  return { styleRepairUsed, styleFieldCoverage, styleRuleCount, styleAvoidCount, styleEvidenceCount };
}
