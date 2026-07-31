# My Agent World (dpi content repo)

This is a starter content repository for [pi-dpi](https://github.com/oc101363-creator/pi-dpi).
Fork or copy this repo (keep it **private** — it will hold your session archives),
then bind it in pi:

```
/dpi-agent-login <your-fork-url>
```

## Structure

| Path | Purpose |
| --- | --- |
| `agents/<name>/SYSTEM.md` | Agent persona (injected into system prompt every turn) |
| `agents/<name>/agent.json` | Capability declaration: `{ description, skills, extensions }` |
| `agents/<name>/prompts/` | Agent-specific prompt templates (`xxx.md` → `/xxx`) |
| `skills/` | Skill registry (flat `<name>/SKILL.md` entries) |
| `extensions/` | Extension registry (flat `<name>.ts` or `<name>/index.ts` directories) |
| `machines/<hostname>.json` | Per-machine overrides (proxy, recordSessions) |
| `memory/<agent>/*.md` | Long-term memory (deprecated, see docs) |
| `sessions/<agent>/` | Session archives by agent |

## Add an agent

Create `agents/<name>/SYSTEM.md` and `agent.json`, declare skills/extensions from the
registries, push — syncs to all your machines automatically.

## Add a skill

Create `skills/<name>/SKILL.md`, then enable it with `/dpi-skills` (writes back to agent.json).

## Add an extension

Create `extensions/<name>.ts` (or `extensions/<name>/index.ts` for multi-file), then enable
with `/dpi-extensions`.
