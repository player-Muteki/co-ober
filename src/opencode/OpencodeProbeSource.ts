export interface OpencodeProbeSource {
  cliPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function captureOpencodeProbeSource(source: OpencodeProbeSource): Required<OpencodeProbeSource> {
  return { cliPath: source.cliPath.trim(), cwd: source.cwd, env: { ...(source.env ?? process.env) } };
}

export function opencodeProbeSourceKey(source: Required<OpencodeProbeSource>): string {
  // Private and ephemeral: never persist, log or display environment values.
  return JSON.stringify([
    source.cliPath,
    source.cwd,
    Object.keys(source.env)
      .sort()
      .map((key) => [key, source.env[key]]),
  ]);
}
