# Task for analysis.repo-migration-implementer

Consolidate the accumulated dpi-console changes into a green test suite and a clean commit (pi-dpi, worktree /Users/mingkaichen/.pi/agent/git/github.com/oc101363-creator/pi-dpi-tmp-fix, branch tmp-fix).

Context: this worktree's working tree already contains the full set of accumulated source changes (uncommitted, copied from the deployed engines):
- src/dpi-console.ts: minimal forms (gateway = baseUrl+key only, id derived from URL; provider = baseUrl+key+API select, id derived; models imported wholesale, no toggle picker), baseUrl normalization with /v1
- src/gateway-writer.ts: push timeout 30s (was 60s)
- src/gateway-catalog.ts: inferContextWindow family rules (deepseek-v4 → 1048576), inferModelApi (gpt-5* → openai-responses), pi official catalog priority (loadPiModelCatalog reads ~/.pi/agent/models-store.json; official contextWindow/maxTokens/reasoning/api win over rules)
- src/gateway-profile.ts: GatewayModel.api field + validation
- src/gateway-projection.ts: piModel passes api through

Current state: `npm test` → 12 failures, all in test/dpi-console.test.ts (old tests drive the old form: id → name → baseUrl → key → API-input, plus toggle picker flows). Everything else passes (202 passed).

Tasks:
1. Update test/dpi-console.test.ts so ALL tests pass against the new forms:
   - addGatewayFlow: inputs are now [baseUrl, key]; id derived from baseUrl (https://sui-xiang.com → sui-xiang, baseUrl normalized to /v1); label = id; URL-in-id-field tests become URL-as-baseUrl tests.
   - addProviderFlow: inputs are [rawBaseUrl (Enter = gateway baseUrl → then manual id prompt), apiKey (Enter = reuse), API picker via ui.select in UI mode]; when rawBaseUrl given, id derived (https://api.apimart.ai/v1 → api-apimart); when empty, manual id input appears; API type via select; models imported wholesale (no toggle picker, no showVimListPicker mock needed).
   - Keep the spirit of each existing test (no-credential-store assertion, model-scan-failure cleanup, URL guidance, allowed-API-list notify for non-UI fallback, schema 2 baseUrl/apiKey written, committed+pushed).
2. Do NOT change any src/ files (they are the intended final state).
3. Do NOT bump version.
4. Commit all src+test changes on branch tmp-fix with clear messages (e.g. "feat: minimal add forms, api/context inference, pi catalog priority" and "test: align console tests with minimal forms" — split as you see fit).
5. Verify: npm test all green (214+), npm run typecheck clean.

Write full report to:
/Users/mingkaichen/.pi/agent/git/github.com/oc101363-creator/pi-dpi-tmp-fix/.superpowers/sdd/2026-08-09-dpi-console/task-14-report.md

Return only: status, commit SHA(s), one-line test summary, concerns.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files, validation-output

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```