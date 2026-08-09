import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAgentManifest,
  writeAgentManifestExtensions,
} from "../src/config.ts";
import {
  runRegistryManager,
  type RegistryManagerConfig,
} from "../src/registry-manager.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runRegistryManager", () => {
  it("keeps declared extensions that are absent from the content registry when exiting unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "dpi-registry-manager-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const repo = join(root, "repo");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    mkdirSync(join(agentDir, "dpi"), { recursive: true });
    writeFileSync(
      join(agentDir, "dpi", "config.json"),
      JSON.stringify({ repoUrl: "https://example.test/agent.git", repoPath: repo, currentAgent: "coder" }),
    );
    mkdirSync(join(repo, "agents", "coder"), { recursive: true });
    writeFileSync(
      join(repo, "agents", "coder", "agent.json"),
      JSON.stringify({ description: "test", skills: [], extensions: ["managed", "external-package-extension"] }),
    );

    let reloads = 0;
    const context = {
      hasUI: true,
      ui: {
        custom: (factory: (tui: { requestRender(): void }, theme: { fg(_color: string, text: string): string }, keybindings: unknown, done: (value: unknown) => void) => { handleInput?(data: string): void }) => {
          let result: unknown;
          const component = factory(
            { requestRender() {} },
            { fg: (_color, text) => text },
            undefined,
            (value) => {
              result = value;
            },
          );
          component.handleInput?.("escape");
          return Promise.resolve(result);
        },
        notify() {},
      },
      reload: async () => {
        reloads++;
      },
    };
    const registry: RegistryManagerConfig = {
      kindLabel: "Extension",
      declaredField: "extensions",
      scanRegistry: () => [{ name: "managed", description: "Managed extension" }],
      readDeclared: (repoPath, agent) => readAgentManifest(repoPath, agent).extensions,
      writeDeclared: writeAgentManifestExtensions,
      deletePath() {},
    };

    await runRegistryManager(context as never, registry);

    expect(readAgentManifest(repo, "coder").extensions).toEqual([
      "managed",
      "external-package-extension",
    ]);
    expect(reloads).toBe(0);
    expect(readFileSync(join(repo, "agents", "coder", "agent.json"), "utf-8")).toContain(
      "external-package-extension",
    );
  });
});
