import { afterEach, describe, expect, it } from "vitest";
import { validateVertexConfig, vertexEnv } from "./vertex";

const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

describe("validateVertexConfig", () => {
  it("accepts a project ID and region, normalising the region", () => {
    expect(validateVertexConfig({ projectId: " sigma-axis-501009-c0 ", region: "US-East5" })).toEqual({
      projectId: "sigma-axis-501009-c0",
      region: "us-east5",
    });
  });

  it("rejects malformed project IDs and regions", () => {
    expect(() => validateVertexConfig({ projectId: "My Project", region: "global" })).toThrow(/project ID/);
    expect(() => validateVertexConfig({ projectId: "my-project-123", region: "us east" })).toThrow(/region/);
  });
});

describe("vertexEnv", () => {
  it("runs Claude Code on Vertex from the CLI's own home and blanks a daemon API key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(vertexEnv({ projectId: "my-project-123", region: "global" })).toEqual({
      CLAUDE_CONFIG_DIR: null,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: null,
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "my-project-123",
      CLOUD_ML_REGION: "global",
      ANTHROPIC_API_KEY: "",
    });
  });
});
