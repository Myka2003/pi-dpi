# Changelog

All notable changes to pi-dpi will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
