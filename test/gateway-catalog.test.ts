import { describe, expect, it } from "vitest";
import { fetchGatewayModels } from "../src/gateway-catalog.ts";

describe("gateway catalog", () => {
  it("imports flat data[] as models without grouping", async () => {
    const models = await fetchGatewayModels("https://api.example.com/v1", "sk-x", {
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.example.com/v1/models");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-5", display_name: "GPT-5" },
            { id: "claude-opus-4-8", display_name: "Opus" },
            { id: "deepseek-v4-flash" },
          ],
        }), { status: 200 });
      },
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-5", "claude-opus-4-8", "deepseek-v4-flash"]);
    expect(models[0].name).toBe("GPT-5");
    expect(models[0].input).toEqual(["text"]);
  });

  it("rejects non-ok responses", async () => {
    await expect(
      fetchGatewayModels("https://api.example.com/v1", "sk-x", {
        fetchImpl: async () => new Response("{}", { status: 401 }),
      }),
    ).rejects.toThrow(/401/);
  });
});
