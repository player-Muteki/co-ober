import type { AvailableCommand } from '../types';

// Command catalog: merges runtime commands with built-in ones
export class CommandCatalog {
  private commands: AvailableCommand[];

  constructor() {
    // Always include built-in commands
    this.commands = [
      { name: 'compact', description: 'compact the session' },
      { name: 'help', description: 'Show all available commands' },
    ];
  }

  add(cmd: AvailableCommand): void {
    const existing = this.commands.findIndex((c) => c.name === cmd.name);
    if (existing >= 0) {
      this.commands[existing] = cmd;
    } else {
      this.commands.push(cmd);
    }
  }

  setAll(cmds: AvailableCommand[]): void {
    this.commands = cmds;
    // Ensure built-ins are present
    if (!this.commands.some((c) => c.name === 'compact')) {
      this.commands.push({ name: 'compact', description: 'compact the session' });
    }
    if (!this.commands.some((c) => c.name === 'help')) {
      this.commands.push({ name: 'help', description: 'Show all available commands' });
    }
  }

  getAll(): AvailableCommand[] {
    return [...this.commands];
  }

  find(name: string): AvailableCommand | undefined {
    return this.commands.find((c) => c.name === name);
  }

  has(name: string): boolean {
    return this.commands.some((c) => c.name === name);
  }
}
