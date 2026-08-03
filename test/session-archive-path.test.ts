import { describe, expect, it } from "vitest";
import { chooseArchivePath } from "../src/session-archive-path.ts";

describe("chooseArchivePath", () => {
  it("keeps an existing fork path on later saves", () => {
    const result = chooseArchivePath({
      basePath: "sessions/coder/original.jsonl",
      session: "original.jsonl",
      previousSession: "original.jsonl",
      previousPath: "sessions/coder/fork.jsonl",
      previousBlob: "blob-local",
      remoteBlob: "blob-original",
      branchPath: "sessions/coder/new-fork.jsonl",
    });

    expect(result).toEqual({
      path: "sessions/coder/fork.jsonl",
      branched: true,
    });
  });

  it("creates one fork when the base path changed remotely", () => {
    const result = chooseArchivePath({
      basePath: "sessions/coder/original.jsonl",
      session: "original.jsonl",
      previousSession: "original.jsonl",
      previousPath: "sessions/coder/original.jsonl",
      previousBlob: "blob-local",
      remoteBlob: "blob-other-machine",
      branchPath: "sessions/coder/new-fork.jsonl",
    });

    expect(result).toEqual({
      path: "sessions/coder/new-fork.jsonl",
      branched: true,
    });
  });
});
