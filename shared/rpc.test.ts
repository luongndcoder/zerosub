import { describe, expect, it } from "vitest";
import * as rpc from "./rpc";

// Paseo rejects the whole plugin at install time when any RPC name breaks this rule.
const PASEO_RPC_NAME = /^[a-z][a-z0-9._-]*$/;

describe("RPC names", () => {
  it("are all valid Paseo plugin RPC method names", () => {
    const names = (Object.values(rpc) as unknown[]).flatMap((value) => {
      const contract = value as { name?: unknown; input?: unknown };
      return typeof contract.name === "string" && contract.input ? [contract.name] : [];
    });
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(name).toMatch(PASEO_RPC_NAME);
  });
});
