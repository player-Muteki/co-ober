import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';

/** The major generation of an OpenCode install that this plugin has a wire for. */
export type OpencodeNativeGeneration = 1 | 2;

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_MAX_CHARS = 4_000;

export interface OpencodeVersionDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  timeoutMs?: number;
}

export interface OpencodeVersionReading {
  /** Trimmed `--version` stdout, kept even when it holds no version token. */
  raw: string;
  /** First dotted-number token found in the output, else undefined. */
  version: string | undefined;
  /** Major generation the version names (1 or 2); undefined otherwise. */
  generation: OpencodeNativeGeneration | undefined;
  /** True when the CLI could not be run, timed out, or exited non-zero. */
  failed: boolean;
}

/**
 * Pull the version out of `opencode --version` output. The CLI may wrap the
 * number in a banner ("opencode v1.5.3", "1.5.3-internal"), so the first dotted
 * numeric run is taken rather than assuming the whole line is the version. The
 * token — not the line — is the reading, so the caller can show the version the
 * binary named instead of the decoration around it.
 */
export function parseOpencodeVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+(?:\.\d+)?/u);
  return match ? match[0] : undefined;
}

/**
 * Classify an observed version by its leading major. Only 1 and 2 name a
 * generation this plugin has a protocol for; a 0, a 3, or an unreadable string
 * all come back undefined. The probe never rounds an unknown major into a
 * supported one — that would certify a capability the version did not state.
 */
export function opencodeNativeGeneration(version: string | undefined): OpencodeNativeGeneration | undefined {
  if (!version) return undefined;
  const major = Number(version.match(/^(\d+)/u)?.[1]);
  return major === 1 || major === 2 ? major : undefined;
}

/**
 * Ask the configured OpenCode binary what it is, by running `<path> --version`.
 * This is observation only: it never throws, and a CLI that is missing, hangs,
 * or answers without a recognizable number comes back as a reading that says so
 * (`failed`, or an undefined `version`) rather than a guessed one. Later work
 * that turns on V2-only behaviour gates on `generation === 2` — a fact measured
 * here, not assumed from a config toggle.
 */
export async function detectOpencodeVersion(
  cliPath: string,
  deps: OpencodeVersionDeps = {},
): Promise<OpencodeVersionReading> {
  const empty: OpencodeVersionReading = { raw: '', version: undefined, generation: undefined, failed: true };
  if (!cliPath?.trim()) return empty;

  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? VERSION_TIMEOUT_MS;

  let raw: string;
  try {
    raw = await runVersion(spawnFn, cliPath.trim(), ['--version'], env, platform, timeoutMs);
  } catch {
    return empty;
  }

  const trimmed = raw.trim().slice(0, VERSION_OUTPUT_MAX_CHARS);
  const version = parseOpencodeVersion(trimmed);
  return { raw: trimmed, version, generation: opencodeNativeGeneration(version), failed: false };
}

function runVersion(
  spawnFn: NonNullable<OpencodeVersionDeps['spawn']>,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  timeoutMs: number,
): Promise<string> {
  const info = getSpawnInfo(command, args, platform, env);
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(info.command, info.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      if (stdout.length > VERSION_OUTPUT_MAX_CHARS) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A version probe answers on exit 0. Any other exit — or a killed process —
      // is an attempt that did not produce a reading, not a version of zero, so it
      // rejects and the caller reports "could not be read" rather than a number.
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit code ${code}`));
    });
  });
}
