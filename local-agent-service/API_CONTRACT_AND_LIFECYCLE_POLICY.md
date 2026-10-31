# Local Agent API Contract and Lifecycle Policy

Status: implementation companion to `LOCAL_AGENT_API_MATRIX.md`; reviewed against the current `main` consumers and the API route implementation on 2026-10-20.

This document deliberately distinguishes observed behavior from a target contract. It is not an OpenAPI specification and must not be used to generate clients until each request and response schema has executable coverage.

## 1. Compatibility rules

1. Do not remove or rename an endpoint based only on a missing call-site in the current extension. CLI scripts, released extension versions and manual clients may still depend on it.
2. Request validation failures use HTTP 400; unauthenticated requests use 401; rejected Origin/Host requests use 403; oversized bodies use 413; missing resources use 404 where the endpoint's existing contract already uses resource semantics.
3. During error migration, preserve the existing `error` field shape at each endpoint. Additive fields may be introduced first; changing `error` from string to object (or vice versa) requires client compatibility evidence and a separately tested migration.
4. For existing lookup endpoints returning `{found:false}`, retain that behavior until a versioned contract is introduced. Do not silently change it to 404.
5. Every mutation must document whether it is synchronous, creates durable state, starts background work, or is idempotent.

## 2. Endpoint families and owners

| Family | Representative routes | Main implementation / state owner | Contract focus |
|---|---|---|---|
| Health and diagnostics | `GET /health`, `GET /api/settings/diagnostics` | `routes.ts`, config | Avoid exposing absolute paths beyond trusted local diagnostics |
| Model discovery | `GET /v1/models`, `GET /api/codebuddy/models` | model catalog | Distinguish configured models from runtime availability |
| Chat and literary operations | `POST /v1/chat/completions`, `POST /api/translate/document/literary/analyze`, `POST /api/translate/document/literary/review` | `routes.ts`, agents and literary modules | OpenAI-compatible response envelope; request validation; stable errors |
| History and translation cache | `GET/DELETE /api/history`, `POST /api/cache/translation/{get,set,delete}`, `DELETE /api/cache/translation` | DB helpers | Bounds, TTL semantics, data retention and clear behavior |
| Legacy document sessions | `POST /api/documents/session/{summary,get,save}`, `DELETE /api/documents/session/:sessionId` | `routes.ts`, SQLite | Keep `found:false` compatibility; validate stable IDs |
| Legacy batch planning | `POST /api/documents/batches` | `routes.ts` | Retain while external and released-client use is unverified |
| Durable project/source/segments | `/api/documents/projects`, `/source`, `/source-file`, `/segments`, `/translations/import` | `projectRoutes.ts`, `projectStore.ts` | Source revision immutability, pagination, import rollback, manual edit validation |
| Context graph and literary memory | `/context-graph`, `/context-graph/status`, `/context-graph/analyze`, `/context-graph/review`, `/literary-memory` | context graph and project store | Background preprocessing status, review enums, revision history |
| Runs and trajectory | `/runs`, `/runs/:runId`, `/resume`, `/cancel`, `/accept`, `/events`, `/translation-briefs` | `translationAgent.ts`, project store | Idempotent start/resume, cancellation boundary, durable event cursor |
| Quality audit | `/quality-audit`, `/quality-audit/repair`, `/quality-evaluations` | `qualityAudit.ts`, project store | Long-running audit latency, run ID validation, evaluation review schema |

See `LOCAL_AGENT_API_MATRIX.md` for the source-level route inventory and known extension call sites.

## 3. Error response migration

The current service has legacy error bodies with incompatible shapes, including `{error:string}` and `{error:{message,type}}`. Do not perform a global breaking rewrite. Migration should be staged:

- Stage A: add `message` and a stable machine-readable `code` to error responses where safe, while retaining the existing `error` value and status code.
- Stage B: update the extension client to read `error.message`, legacy object `error.message`, and legacy string `error`; test all three forms.
- Stage C: standardize new/versioned endpoints on `{error:{code,message,type,requestId?}}`; migrate old endpoints only after compatibility tests cover supported extension versions.
- Never expose stack traces, filesystem paths, prompts, source text, or provider secrets in public error bodies. Keep diagnostic details in local logs.

Suggested error codes: `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN_ORIGIN`, `NOT_FOUND`, `REQUEST_TIMEOUT`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `VALIDATION_ERROR`, `RATE_LIMITED`, `INTERNAL_ERROR`, and domain-specific codes where callers need to branch. The shared helper maps HTTP 408, 422, and 429 explicitly; other unrecognized 4xx statuses fall back to `REQUEST_FAILED`.

## 4. Long-running operation contract

The durable Run model is the source of truth. HTTP responses must not imply that an asynchronous operation has completed merely because it was accepted.

- `POST .../runs`: return 202 when a new Run has been durably created and queued/started; return the existing Run or a documented conflict for duplicate submissions according to an explicit idempotency rule.
- `POST .../runs/:runId/resume`: repeated resume requests must not start multiple executors for the same Run. The existing `alreadyRunning` response should remain supported.
- `POST .../runs/:runId/cancel`: the response should distinguish a cancellation request from confirmed executor termination. A cancelled status must not be written as terminal while an in-flight worker can still commit candidates, unless writes are fenced by a cancellation token/version.
- Run transitions and candidate writes must be guarded in the durable store, not only by in-memory flags. Startup recovery must mark interrupted work resumable without replaying already committed segment results.
- Event consumers should treat `after` as an exclusive cursor and tolerate duplicate delivery; the persisted event ID, not wall-clock timestamps, should define ordering.
- Long operations need explicit timeout behavior and durable failure details. Do not hold an HTTP request open for whole-book preprocessing/audit if the endpoint is intended to be asynchronous.

### Required lifecycle tests before declaring this contract complete

1. Two simultaneous start requests for the same project/scope do not create two active executors.
2. Two simultaneous resume requests for one Run start at most one executor.
3. Cancel while a model call is in flight prevents late candidate writes from reviving or mutating a terminal Run.
4. Process restart during a Run preserves completed segment results and makes only unfinished work resumable.
5. Retried event polling with the same cursor returns stable ordering and no missing events.
6. A timeout or provider failure leaves a durable, inspectable terminal/interrupted state and can be resumed where policy allows.

These are acceptance criteria, not claims that the current implementation already passes them.

## 5. Deprecation policy

No endpoint in the following list is removed by this change:

| Endpoint family | Current evidence | Policy |
|---|---|---|
| `POST /api/documents/batches` | Not found in current extension call-site search; server integration test exists | Keep; document as legacy batch planner. Add deprecation headers only after external/released-client review |
| Session `get` and `DELETE` | Not found in current extension call-site search; related session persistence remains used | Keep; do not infer dead code from missing current call sites |
| TranslationBrief snapshot query | No direct UI caller found; useful audit snapshot | Keep as audit/diagnostic endpoint |
| Literary analyze/review | Current extension and tests call these endpoints | Not deprecated; they remain a separate one-shot workflow from durable project Runs |

Deprecation requires: (a) current and released-client search, (b) usage telemetry where available without collecting document content, (c) a documented replacement, (d) a minimum support window, and (e) a test proving the replacement covers the old workflow. Since the service is local-first and may have no telemetry, absence of observed traffic is not evidence of absence of use.

## 6. Implementation status update (2026-10-20)

The shared `sendApiError` helper is now used by the common route adapter and project-route error handling for the covered paths. It adds top-level `message` and stable `code` fields while preserving legacy `error` values and domain fields such as `run`. The OpenAI-compatible chat endpoint retains its provider-specific error envelope.

HTTP regression coverage now checks malformed cache TTL, malformed session ID, invalid segment pagination, and unknown-endpoint 404 responses. Existing project-store tests also cover candidate-write rejection after cancellation and the rule that cancelled/completed Runs cannot be revived. These tests have been inspected in source but have not been executed in this editing environment.

Remaining gaps at the time of the first update were subsequently narrowed: body-parser and Host/Origin middleware errors now use the shared helper, and a lightweight route inventory/drift check exists. Not every provider error envelope is identical, and request/response schemas are not yet comprehensively validated.

## 7. Implementation status update (2026-10-20, continued)

The shared error envelope now also covers the server's Origin/Host rejection, JSON body parse failures (400/413), and unhandled request errors. The legacy string-valued `error` remains present on these paths, with additive `message` and `code`.

A 54-entry `api-route-manifest.json` and `check:api-contract` script have been added, and the local-agent-service GitHub Actions workflow invokes the check. The current checker verifies that each declared implementation signature still exists and that the manifest has no duplicate method/path pairs. It is intentionally only a one-way source-signature check: it does not yet prove that every implementation route is registered in the manifest, and it does not validate full request/response schemas. Do not describe it as complete OpenAPI or full route drift prevention.

HTTP tests now include malformed JSON and rejected Origin error-envelope assertions. The new checker and tests have not yet been executed in a real Node/CI environment during this editing session.

## 8. OpenAPI and executable contract coverage

Do not label a hand-written partial schema as complete OpenAPI. Before publishing an OpenAPI document:

- Extract every route and method from `routes.ts`, `projectRoutes.ts`, and middleware.
- Define request, success response, and error response schemas for each route.
- Cover body-parser errors, authentication, Origin/Host rejection, unknown routes, and unsupported methods.
- Add HTTP integration tests for boundary values and response shapes, not just store-level unit tests.
- Add a drift check so every registered route is either represented in the manifest or explicitly marked internal/legacy.
- Generate OpenAPI from the reviewed manifest or validate the manifest against the OpenAPI document in CI.

The manifest should not become a second, untested source of truth. The implementation and executable tests remain authoritative until drift validation is in CI.


## 9. Provider failure envelope and helper-level tests (2026-10-20)

Non-OpenAI API provider failures now use the shared `sendApiError` mapping so status-to-code behavior is consistent with validation and middleware errors. The payload continues to include `requestId`, `provider`, `model`, `status`, and `durationMs`, while the legacy string-valued `error` remains available. `/v1/chat/completions` retains its dedicated OpenAI-compatible `error` object and snake_case metadata.

A focused `tests/middleware.test.mjs` suite covers the helper's legacy error preservation, no-store header, details merging, and status-code mapping. These are source changes only until the repository's GitHub Actions run reports success; do not infer passing tests from the presence of assertions.


## 10. Error-code mapping follow-up (2026-10-20)

The shared error helper now assigns explicit machine codes for HTTP 408 (`REQUEST_TIMEOUT`), 422 (`VALIDATION_ERROR`), and 429 (`RATE_LIMITED`) instead of grouping 429 under the generic `REQUEST_FAILED` fallback. Helper-level regression cases cover these statuses as well as 500/502/503/504. The assertions have been committed; their execution status must be taken from the matching GitHub Actions run, not inferred from source presence.


## 11. Run lifecycle verification and OpenAPI coverage (2026-10-20)

The document-project test suite now includes a durable-store reopen test for a partially completed Run: it verifies the Run remains discoverable, the candidate translation survives process-style Store reconstruction, and a cancelled Run cannot be queued again after another reconstruction. A concurrent-create regression test asserts that two simultaneous attempts cannot both acquire the workspace Run lock or leave an orphan Run.

`openapi.json` introduces an OpenAPI 3.1 contract for the highest-risk Run collection/create, resume, and cancel endpoints, plus shared error DTO and Run schemas. `scripts/check-api-route-manifest.mjs` validates local OpenAPI references and required lifecycle operations in addition to the existing source/manifest drift checks. Coverage is intentionally marked `partial`: the 54-entry route manifest remains the route inventory, not a claim that every endpoint has a complete request/response schema. Remaining schema work is to replace the generic `GenericRequest` / `GenericSuccess` placeholders with endpoint-specific request and response schemas for every `inventory-only` operation. The existing `check:api-contract` CI step validates local OpenAPI references, required lifecycle operations, route-count parity, and route-to-path/method mapping; it does not yet validate the runtime response bodies against schemas or establish full OpenAPI coverage.


## 12. Literary preprocessing readiness gate (2026-10-31)

Literary document translation must not begin model translation until the current source revision has a complete, language-matched Context Graph. This is distinct from the asynchronous Run-creation contract above:

- The normal extension path checks the compact `GET .../context-graph/status` DTO before creating a literary Run. Unknown, failed, stale, language-mismatched or incomplete state is fail-closed. First-time preprocessing is automatically started; failed/stale analysis requires explicit reanalysis.
- `POST .../runs` may still return **202** for direct API/older clients that created a durable queued Run before the UI gate existed. **202 means the Run record was accepted, not that translation has begun.**
- `executeRun` is the authoritative server-side gate. It validates source revision, current analysis version, language pair, supported strategy, non-empty samples, style completeness and B-workflow checkpoints before changing the Run to `running`, reading execution segments or calling a translation model.
- If preprocessing cannot become ready, the Run fails with a diagnostic event/error and no translation candidates are produced. Technical-document Runs do not require the literary Context Graph.

See [ADR-0005](../docs/adr/0005-literary-preprocessing-before-translation.md) for the decision and [TRANSLATION_PIPELINE.md](../docs/TRANSLATION_PIPELINE.md) for the full flow.
