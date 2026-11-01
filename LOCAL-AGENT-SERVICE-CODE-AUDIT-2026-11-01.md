# Local Agent Service 代码审查修复记录（2026-11-01）

本次修改处理了此前审查确认的三项问题，并同步 README、AGENTS 与架构文档。目标是避免历史失败污染重试范围、确保模型调用次数受配置约束，以及避免原始文件写入失败后项目已切换到新来源版本。

## 1. Failed scope 只选择当前来源版本仍失败的片段

原实现仅按 `run_segments.status='failed'` 汇总 segment ID。旧来源版本的失败可能污染新版本；某段后来成功并采纳后，旧失败仍可能让它再次进入 failed scope。

修改后：
- 失败记录 JOIN 所属 `translation_runs`，限定当前 `source_revision_id`。
- 失败记录的 `source_hash` 必须与当前 `source_segments` 一致。
- 当前来源版本已有人工译文时，不因历史失败再次选择。
- 当前 Run fingerprint 下已有有效自动采纳译文时，不因历史失败再次选择。
- 旧 fingerprint 的机器译文仍可进入修复范围，不会把过期译文误判为已修复。

新增回归测试覆盖：
- Run A 失败，Run B 成功并采纳，Run C 的 failed scope 不再选择该片段。
- 当前人工编辑保护。
- 旧 source revision 的失败不污染新 revision。

## 2. maxModelAttempts 限制真实模型调用总数

原实现把 `maxModelAttempts` 用作外层重试轮数，但第二轮会将缺失片段按每组 4 段拆分。因此配置为 2 时，一个 16/24 段 batch 在第一次全缺失后仍可能产生多次模型调用。

修改后：
- `maxModelAttempts` 表示单个 batch 的模型调用总次数，包含首次调用。
- 首次调用仍按计划 batch 请求。
- 首次响应不完整时，剩余预算只用于一次定向补齐请求，并携带全部缺失 ID。
- 翻译主流程不再调用按 4 段切分的重试逻辑；保留通用分组 helper 的导出兼容性，但它不参与 batch 模型调用调度。

默认值为 2，因此一个 batch 最多调用模型两次；第一次完整返回则只调用一次。

## 3. 原始文件与 source revision 一致提交

原始文件更新原先先提交 SQLite source revision/current pointer，再写入原始文件。文件写入失败会留下已切换但缺少原始文件的当前 revision。

修改后：
- 新增 `createSourceRevisionWithFile`：先写临时文件，再 rename 为 revision 专属的不可变文件。
- 随后在 SQLite 事务中插入 source revision、原始文件 path/hash/size，并切换 current revision。
- 数据库事务失败时删除本次新文件。
- 如果数据库已经提交，即使后续目录索引或事件写入失败，也不会删除当前 revision 对应的原始文件。
- 更新原文的 HTTP API 改为调用这一单一操作，不再先后执行 revision commit 和 file write 两个独立步骤。
- 进程若在文件 rename 后、SQLite commit 前意外退出，最多留下无数据库引用的孤立文件；current revision 不会指向缺失文件。

新增成功提交和活动 Run 阻止切换时的回滚测试。

## 4. 文档同步

- README 更新 TranslationBrief 1,000,000 字符安全阈值、历史译例 8 条/4,000 字符软预算、模型调用总预算，以及实际文件/ZIP/片段上限。
- AGENTS 明确历史译例预算只约束可选示例，不得扩展为整个 TranslationBrief 的硬截断；补充 failed scope、模型调用预算和原始文件提交约束。
- 架构文档同步自动采纳、事后修改/拒绝、failed scope 来源绑定和原始文件 revision 一致提交。

## 5. 验证状态

已增加/更新的自动化测试：
- failed scope：后续成功采纳结果不再被历史失败重选。
- failed scope：人工编辑不进入失败重试范围。
- failed scope：旧来源版本的失败不进入当前来源版本。
- source revision：原始文件与 revision 一起提交。
- source revision：活动 Run 阻止切换时，当前 revision 保持不变且 staged 文件清理。

代码已提交到 `main`。最终测试结论以这些提交触发的 GitHub Actions 为准；CI 尚未完成前，不将修改标记为验证通过。
