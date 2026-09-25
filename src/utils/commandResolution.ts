import { extname, delimiter } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

/**
 * Determine how to spawn a command on Windows.
 *
 * On POSIX the bare command is resolved through PATH plus the installer
 * directories GUI apps routinely miss (Obsidian on a desktop does not
 * inherit the shell PATH from .profile), so `opencode` still launches when
 * it only lives in e.g. ~/.opencode/bin.
 */
export function getSpawnInfo(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (platform !== 'win32') {
    const resolved = resolveCommandPath(cmd, platform, env);
    return { command: resolved ?? cmd, args };
  }

  const resolved = resolveWindowsCommand(cmd);
  if (resolved.useCmdShell) {
    const commandLine = [
      quoteCmdArg(resolved.command),
      ...args.map((arg) => quoteCmdArg(arg)),
    ].join(' ');
    const comspec = env.ComSpec ?? 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', commandLine] };
  }

  return { command: resolved.command, args };
}

interface WindowsCommandResolution {
  command: string;
  useCmdShell: boolean;
}

/**
 * Resolve a Windows command to its full path, determining whether it needs a
 * cmd.exe shell wrapper (.cmd / .bat files).
 */
function resolveWindowsCommand(cmd: string): WindowsCommandResolution {
  const ext = extname(cmd).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return { command: cmd, useCmdShell: true };
  if (ext) return { command: cmd, useCmdShell: false };

  if (cmd.includes('\\') || cmd.includes('/')) {
    const exe = `${cmd}.exe`;
    if (existsSync(exe)) return { command: exe, useCmdShell: false };
    const cmdExt = `${cmd}.cmd`;
    if (existsSync(cmdExt)) return { command: cmdExt, useCmdShell: true };
    const batExt = `${cmd}.bat`;
    if (existsSync(batExt)) return { command: batExt, useCmdShell: true };
    return { command: cmd, useCmdShell: false };
  }

  const pathExts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
    .split(';')
    .map((value) => value.toLowerCase());
  const pathDirs = (process.env.PATH ?? '').split(delimiter);

  for (const dir of pathDirs) {
    for (const extPart of pathExts) {
      const candidate = `${dir}\\${cmd}${extPart}`;
      if (existsSync(candidate)) {
        const useCmdShell = extPart === '.cmd' || extPart === '.bat';
        return { command: candidate, useCmdShell };
      }
    }
  }

  return { command: cmd, useCmdShell: false };
}

/**
 * Quote a command-line argument for cmd.exe.
 */
function quoteCmdArg(value: string): string {
  if (!value) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Install locations a desktop-launched Obsidian usually misses in PATH. */
function posixExtraBinDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || homedir();
  return [
    `${home}/.opencode/bin`,
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ];
}

/**
 * Resolve a command (quoted, bare, or explicit path) to an existing
 * executable file, or null when nothing matches. Used both for spawning and
 * for the settings/diagnostics path verdict so they can never disagree.
 */
export function resolveCommandPath(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const bare = cmd.trim().replace(/^"(.+)"$/, '$1').replace(/^'(.+)'$/, '$1').trim();
  if (!bare) return null;

  if (platform === 'win32') {
    const names = /\.(cmd|bat|exe)$/i.test(bare) ? [bare] : [bare, `${bare}.cmd`, `${bare}.bat`, `${bare}.exe`];
    if (bare.includes('\\') || bare.includes('/')) {
      for (const name of names) if (exists(name)) return name;
      return null;
    }
    const pathDirs = (env.PATH ?? '').split(';').filter(Boolean);
    for (const dir of pathDirs) {
      for (const name of names) {
        const candidate = `${dir}\\${name}`;
        if (exists(candidate)) return candidate;
      }
    }
    return null;
  }

  if (bare.includes('/')) return exists(bare) ? bare : null;

  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...posixExtraBinDirs(env)];
  for (const dir of dirs) {
    const candidate = `${dir}/${bare}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}
