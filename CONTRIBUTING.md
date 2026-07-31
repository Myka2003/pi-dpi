# Contributing

## Setup
- `npm ci` (installs devDependencies: vitest, typescript)
- `npm run typecheck`、`npm run test` — all green before committing

## Code style
- TypeScript strict; run `npx tsc --noEmit`
- Shared code in `src/` (never in `extensions/` — every `.ts` there is a pi extension entry)
- UI copy in English; code comments in Chinese
- Silent fault-tolerance: never throw on startup/read paths; fail loudly only on user commands

## Commits
Conventional Commits: `feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `ci:` / `chore:`

## Tests
- Pure functions (config, git, registry logic) must have vitest coverage
- TDD: write failing test first

## Pull requests
- Describe the problem, the fix, and how you verified it
- Link related issues
