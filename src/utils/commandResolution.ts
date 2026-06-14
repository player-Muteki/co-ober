import { extname, delimiter } from 'path';
import { existsSync } from 'fs';

/**
 * Determine how to spawn a command on Windows.
 *
 * On non-Windows platforms this is a no-op passthrough.
 */
export function getSpawnInfo(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (platform !== 'win32') return { command: cmd, args };

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
