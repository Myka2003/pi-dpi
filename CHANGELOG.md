# Changelog

All notable changes to pi-dpi will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.8.0] - 2026-08-01

### Changed
- **Session storage model**: content repo clones are now sparse (`--filter=blob:none --sparse`),
  `sessions/` never enters the worktree — browsing uses git metadata (ls-tree), restore/rename/
  delete/archive operate on the git object store on demand. Onboarding: ~5s / few MB instead of
  357MB / minutes. Online-only (confirmed).

## [0.7.1] - 2026-08-01

### Added
- First-run onboarding: `/dpi-agent-login` (no args) asks whether you have a content repo —
  offers local initialization (zero-config, single machine) or the forkable starter template;
  startup prompts when unbound
- Bootstrap now runs `git init` so local binds are real git repos

### Fixed
- Space key in toggle mode was intercepted by the page-down branch (could only toggle with Enter)
- Large archives (>2MB) lost their name (session_info lives at the file tail)
- Renaming the current session's archive now also renames the live session
- `features.tablet` references tolerate missing module (ser7 eval crash)

## [Unreleased]

### Added
- Forkable content-repo template (`templates/content-repo/`) and local-bind bootstrap
- GitHub Actions CI (typecheck + vitest)
- peerDependencies declaration (pi >= 0.80.6)

## [0.7.0] - 2026-08-01

### Added
- `/dpi-` prefixed commands (replaces legacy aliases); sessions rename; vim-style list picker with laptop-friendly keys (^D/^U, ^F/^B)
- Remote watch (3s fetch loop) with auto-pull and live Sync status in agent card
- Save-state visibility (archive/push status, pending commits, rebase conflict alerts)
- Strict skills mode (settings.skills = ["!*"]) and extension-bundled skills auto-discovery
- Generic package integration: vendor npm packages via package.json dependencies + auto npm install
- Companion delete: extensions ↔ same-name skills cascade cleanup

### Changed
- UI copy fully English (comments stay Chinese); session cards refresh every 3s without reload
- session-vcs archives commit immediately (no longer dependent on extension order)
- Card shows current Session (name + file), live-updated on rename

### Removed
- Long-term memory mechanism (sessions only); legacy command aliases

[0.7.0]: https://github.com/oc101363-creator/pi-dpi/compare/...TBD
