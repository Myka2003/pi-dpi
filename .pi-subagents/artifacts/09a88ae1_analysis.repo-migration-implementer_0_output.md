**status**: done

**commit SHA(s)**: `db6baaa7` (feat: minimal add forms, api/context inference, pi catalog priority), `c0acf208` (test: align console tests with minimal forms) — branch `tmp-fix`

**test summary**: `npm test` 27 files / 214 tests passed (was 12 failed), `npm run typecheck` clean

**concerns**: 原 "URL 误粘贴进 provider id 字段" 的专门提示已随旧表单删除，精神由 baseUrl 字段的 `Invalid provider base URL … expected http(s)://host[/v1]` 引导承接；测试断言依赖 URL→id 推导的 TLD 剥离规则（规则调整会改断言值，非脆弱耦合）。