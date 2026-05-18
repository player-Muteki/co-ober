import { Vault, TFile, Notice } from 'obsidian';

/** Read all markdown files under a folder path */
export async function readAllInFolder(vault: Vault, folder: string): Promise<Array<{ path: string; content: string; name: string }>> {
  const results: Array<{ path: string; content: string; name: string }> = [];
  for (const file of vault.getMarkdownFiles()) {
    if (!file.path.startsWith(folder + '/') && file.path !== folder) continue;
    try {
      const content = await vault.read(file);
      results.push({ path: file.path, content, name: file.basename });
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

/** Delete a file and show a notice on failure */
export async function safeDelete(vault: Vault, path: string): Promise<boolean> {
  const file = vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  try {
    await vault.delete(file);
    return true;
  } catch {
    new Notice('Failed to delete file');
    return false;
  }
}

/** Get the basename without extension */
export function basename(path: string): string {
  return path.replace(/(\.[^.]*)?$/, '');
}

/** Check if path matches a glob pattern (simple: endsWith) */
export function globMatch(path: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(path);
  }
  return path === pattern;
}
