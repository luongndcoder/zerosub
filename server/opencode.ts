import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoginMethod, UsageWindow } from "../shared/model";
import { writeJsonAtomic } from "./json-file";
import type {
  EnvPatch,
  FamilyAdapter,
  Identity,
  LoginHandle,
  RedeemReply,
  UsageRead,
} from "./adapter";
import { providerCommand } from "./binaries";
import { detectOpenCodeLimit, detectOpenCodeSignOut } from "./limits";
import { run } from "./process";

/** OpenCode Go's own usage endpoint: the same one Paseo's OpenCode Go usage source reads. */
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** OpenCode's provider id for the Go subscription. */
const GO_PROVIDER = "opencode-go";
/** OpenCode's provider id for its Zen pay-per-use keys. */
const ZEN_PROVIDER = "opencode";

/** One credential, in OpenCode's own `auth.json` shape. */
export interface OpenCodeCredential {
  type: string;
  key?: string;
  refresh?: string;
  access?: string;
  expires?: number;
}

export type OpenCodeCredentials = Record<string, OpenCodeCredential>;

function isCredential(value: unknown): value is OpenCodeCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as OpenCodeCredential;
  return typeof entry.type === "string" && (typeof entry.key === "string" || typeof entry.refresh === "string");
}

/** Reads an `auth.json` file. Anything that isn't a credential is ignored. */
export function parseAuth(raw: unknown): OpenCodeCredentials {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: OpenCodeCredentials = {};
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isCredential(value)) result[provider] = value;
  }
  return result;
}

/** Where OpenCode keeps its credentials, following the same XDG rule OpenCode itself uses. */
export function mainAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

/** Where ZeroSub keeps an account's own credentials. */
export function accountAuthPath(home: string): string {
  return join(home, "auth.json");
}

async function readAuth(path: string): Promise<OpenCodeCredentials> {
  try {
    return parseAuth(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    console.warn(
      "[ZeroSub] could not read the OpenCode credentials at",
      path,
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}

/**
 * A stable id for a set of credentials, so the same account added twice is spotted. Only a hash of
 * the keys is kept: the keys themselves stay in the account's own home.
 */
export function credentialFingerprint(credentials: OpenCodeCredentials): string {
  const parts = Object.keys(credentials)
    .sort()
    .map((provider) => `${provider}:${credentials[provider]?.key ?? credentials[provider]?.refresh ?? ""}`);
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** The Go key of a set of credentials, if it has one. */
export function goKey(credentials: OpenCodeCredentials): string | null {
  const key = credentials[GO_PROVIDER]?.key;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/** The plan an account shows: Go when it has a Go key, Zen when it only has a Zen key. */
export function planOf(credentials: OpenCodeCredentials): string | null {
  if (goKey(credentials)) return "Go";
  if (credentials[ZEN_PROVIDER]?.key) return "Zen";
  return null;
}

export interface GoUsage {
  windows: UsageWindow[];
  /** True when OpenCode Go says the account is rate-limited right now. */
  rateLimited: boolean;
}

interface GoUsageBody {
  usage?: {
    rolling?: { status?: string; percent?: number; resetsAt?: string };
    weekly?: { status?: string; percent?: number; resetsAt?: string };
    monthly?: { status?: string; percent?: number; resetsAt?: string };
  };
}

/** Turns OpenCode Go's usage payload into the windows the account card shows. */
export function parseGoUsage(body: GoUsageBody): GoUsage {
  const windows: UsageWindow[] = [];
  let rateLimited = false;
  const entries = [
    ["rolling", "Rolling", body.usage?.rolling],
    ["weekly", "Weekly", body.usage?.weekly],
    ["monthly", "Monthly", body.usage?.monthly],
  ] as const;
  for (const [id, label, value] of entries) {
    if (!value || typeof value.percent !== "number") continue;
    if (value.status === "rate-limited") rateLimited = true;
    windows.push({
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, value.percent)),
      resetsAt: typeof value.resetsAt === "string" && value.resetsAt ? value.resetsAt : null,
    });
  }
  return { windows, rateLimited };
}

async function fetchGoUsage(key: string, fetchApi: typeof fetch = fetch): Promise<GoUsage> {
  const response = await fetchApi(GO_USAGE_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    // The provider says why: an expired key reads very differently from a revoked one.
    const detail = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
    const message = typeof detail?.error?.message === "string" ? detail.error.message : null;
    throw new Error(message ? `OpenCode Go rejected this key: ${message}` : "OpenCode Go rejected this key.");
  }
  if (response.status === 429) throw new Error("OpenCode Go is busy right now. Try again in a minute.");
  if (!response.ok) throw new Error(`OpenCode Go answered with HTTP ${response.status}.`);
  return parseGoUsage((await response.json()) as GoUsageBody);
}

/** Checks an OpenCode Go key before the account is added, so a wrong key is caught right away. */
export async function verifyGoKey(key: string, fetchApi: typeof fetch = fetch): Promise<void> {
  await fetchGoUsage(key, fetchApi);
}

/**
 * OpenCode reads its credentials from `auth.json`, or from `OPENCODE_AUTH_CONTENT` when that is
 * set — the file is then ignored. ZeroSub uses the variable so an agent can run on another
 * account's key while everything else (config, models, history) stays shared.
 */
export class OpenCodeAdapter implements FamilyAdapter {
  readonly family = "opencode" as const;
  /** A conversation can move to another account: only the key changes, the session does not. */
  readonly portable = true;
  readonly usageSpacingMs = 60_000;

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("opencode");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  async prepareHome(home: string): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
  }

  /** The credentials an account runs on: its own, on top of the ones the user already has. */
  async credentials(home: string | null): Promise<OpenCodeCredentials> {
    if (!home) return readAuth(mainAuthPath());
    return readAuth(accountAuthPath(home));
  }

  async env(home: string | null): Promise<EnvPatch> {
    const own = await this.credentials(home);
    if (Object.keys(own).length === 0) return {};
    // The account's keys win; the user's other providers (and their OAuth tokens) stay available.
    const merged = { ...(await readAuth(mainAuthPath())), ...own };
    // The user's own login is included too: OpenCode reads its credentials when the server starts,
    // so a server that started before a key change would keep using the old key. Handing the keys
    // over in the environment gives every session a server that reads them as they are now.
    return { OPENCODE_AUTH_CONTENT: JSON.stringify(merged) };
  }

  async identity(home: string | null): Promise<Identity> {
    const credentials = await this.credentials(home);
    const signedIn = Object.keys(credentials).length > 0;
    if (!signedIn) {
      return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    }
    const key = goKey(credentials);
    // OpenCode Go is the only provider that can be checked: it answers with the account's usage.
    if (key) {
      try {
        await fetchGoUsage(key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/rejected/i.test(message)) {
          return { signedIn: false, email: null, plan: null, organization: null, identity: null };
        }
      }
    }
    return {
      signedIn: true,
      email: null,
      plan: planOf(credentials),
      organization: null,
      identity: credentialFingerprint(credentials),
    };
  }

  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const credentials = await this.credentials(home);
    const key = goKey(credentials);
    if (!key) {
      return {
        fetchedAt,
        windows: [],
        error: "This account has no OpenCode Go key, so it shows no usage.",
        cached: false,
        resets: null,
      };
    }
    const usage = await fetchGoUsage(key);
    return { fetchedAt, windows: usage.windows, error: null, cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "OpenCode Go doesn't offer banked resets.", left: 0 };
  }

  async login(_home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    throw new Error("Add an OpenCode account by pasting its API key.");
  }

  async logout(home: string): Promise<void> {
    await rm(accountAuthPath(home), { force: true });
  }

  detectLimit = detectOpenCodeLimit;
  detectSignOut = detectOpenCodeSignOut;
}

/** Writes an account's credentials, readable by its user only. */
export async function writeCredentials(home: string, credentials: OpenCodeCredentials): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(accountAuthPath(home), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Replaces the credentials of the user's own OpenCode login, keeping the providers they did not
 * mention. This is what `opencode auth login` would do, so the OpenCode CLI itself uses the new
 * key too.
 */
export async function writeMainCredentials(credentials: OpenCodeCredentials): Promise<void> {
  const path = mainAuthPath();
  const merged = { ...(await readAuth(path)), ...credentials };
  await writeJsonAtomic(path, merged, 0o600);
}
