import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VertexConfig } from "../shared/model";
import type { EnvPatch, Identity, UsageRead } from "./adapter";
import { OVERRIDING_AUTH } from "./claude";

/** GCP project IDs: 6–30 lowercase letters, digits and hyphens, starting with a letter. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** `global` or a region such as `us-east5`. */
const REGION = /^[a-z][a-z0-9-]{1,30}$/;

export function validateVertexConfig(input: { projectId: string; region: string }): VertexConfig {
  const projectId = input.projectId.trim();
  const region = input.region.trim().toLowerCase();
  if (!PROJECT_ID.test(projectId)) throw new Error(`"${projectId}" isn't a valid Google Cloud project ID.`);
  if (!REGION.test(region)) throw new Error(`"${region}" isn't a valid Vertex AI region (for example global or us-east5).`);
  return { projectId, region };
}

/**
 * Where Google's client libraries look for Application Default Credentials, which Claude Code uses
 * on Vertex: `GOOGLE_APPLICATION_CREDENTIALS`, else the file `gcloud auth application-default login` writes.
 */
export function adcPath(): string {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit) return explicit;
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "gcloud", "application_default_credentials.json");
  }
  return join(process.env.CLOUDSDK_CONFIG ?? join(homedir(), ".config", "gcloud"), "application_default_credentials.json");
}

/**
 * A Vertex account runs on the CLI's own home (history, settings, skills and MCP servers stay
 * shared) with Claude Code switched to Vertex. Subscription tokens from the daemon's environment
 * are blanked so they can't take precedence.
 */
export function vertexEnv(config: VertexConfig): EnvPatch {
  const patch: EnvPatch = {
    CLAUDE_CONFIG_DIR: null,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: null,
    CLAUDE_CODE_USE_VERTEX: "1",
    ANTHROPIC_VERTEX_PROJECT_ID: config.projectId,
    CLOUD_ML_REGION: config.region,
  };
  for (const key of OVERRIDING_AUTH) if (process.env[key]) patch[key] = "";
  return patch;
}

/** "Signed in" for Vertex means credentials Claude Code can use are present on this machine. */
export function vertexIdentity(config: VertexConfig): Identity {
  return {
    signedIn: existsSync(adcPath()),
    email: null,
    plan: "Vertex AI · pay per use",
    organization: `${config.projectId} · ${config.region}`,
    identity: `vertex:${config.projectId}:${config.region}`,
  };
}

/** Vertex has quotas, not subscription windows, so there is nothing to read. */
export function vertexUsage(): UsageRead {
  return { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null };
}
