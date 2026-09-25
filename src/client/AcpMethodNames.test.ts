import { describe, expect, it } from 'vitest';
import {
  getAcpMethodCandidates,
  ACP_SERVER_NOTIFICATION_ALIASES,
  ACP_SERVER_REQUEST_ALIASES,
} from './AcpMethodNames';

describe('AcpMethodNames', () => {
  describe('getAcpMethodCandidates', () => {
    it('returns candidates for initialize', () => {
      const candidates = getAcpMethodCandidates('initialize');
      expect(candidates).toEqual(['initialize']);
    });

    it('returns candidates for authenticate', () => {
      const candidates = getAcpMethodCandidates('authenticate');
      expect(candidates).toEqual(['authenticate']);
    });

    it('returns candidates for newSession', () => {
      const candidates = getAcpMethodCandidates('newSession');
      expect(candidates).toContain('session/new');
      expect(candidates).toContain('newSession');
    });

    it('returns candidates for loadSession', () => {
      const candidates = getAcpMethodCandidates('loadSession');
      expect(candidates).toContain('session/load');
      expect(candidates).toContain('loadSession');
    });

    it('returns candidates for listSessions', () => {
      const candidates = getAcpMethodCandidates('listSessions');
      expect(candidates).toContain('session/list');
      expect(candidates).toContain('listSessions');
    });

    it('returns candidates for prompt', () => {
      const candidates = getAcpMethodCandidates('prompt');
      expect(candidates).toContain('session/prompt');
      expect(candidates).toContain('prompt');
    });

    it('returns candidates for cancel', () => {
      const candidates = getAcpMethodCandidates('cancel');
      expect(candidates).toContain('session/cancel');
      expect(candidates).toContain('cancel');
    });

    it('returns candidates for setMode', () => {
      const candidates = getAcpMethodCandidates('setMode');
      expect(candidates).toContain('session/set_mode');
      expect(candidates).toContain('setSessionMode');
    });

    it('returns candidates for setConfigOption', () => {
      const candidates = getAcpMethodCandidates('setConfigOption');
      expect(candidates).toContain('session/set_config_option');
      expect(candidates).toContain('setSessionConfigOption');
    });

    it('prefers the stabilized session/fork wire name for forkSession', () => {
      const candidates = getAcpMethodCandidates('forkSession');
      expect(candidates[0]).toBe('session/fork');
      expect(candidates).toContain('session/unstable_fork');
      expect(candidates).toContain('forkSession');
    });
  });

  describe('ACP_SERVER_NOTIFICATION_ALIASES', () => {
    it('has sessionUpdate aliases', () => {
      expect(ACP_SERVER_NOTIFICATION_ALIASES.sessionUpdate).toContain('session/update');
      expect(ACP_SERVER_NOTIFICATION_ALIASES.sessionUpdate).toContain('sessionUpdate');
    });
  });

  describe('ACP_SERVER_REQUEST_ALIASES', () => {
    it('has requestPermission aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.requestPermission).toContain('session/request_permission');
      expect(ACP_SERVER_REQUEST_ALIASES.requestPermission).toContain('requestPermission');
    });

    it('has elicitationCreate aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.elicitationCreate).toContain('elicitation/create');
      expect(ACP_SERVER_REQUEST_ALIASES.elicitationCreate).toContain('elicitationCreate');
    });

    it('has readTextFile aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.readTextFile).toContain('fs/read_text_file');
      expect(ACP_SERVER_REQUEST_ALIASES.readTextFile).toContain('fs/readTextFile');
    });

    it('has writeTextFile aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.writeTextFile).toContain('fs/write_text_file');
      expect(ACP_SERVER_REQUEST_ALIASES.writeTextFile).toContain('fs/writeTextFile');
    });

    it('has createTerminal aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.createTerminal).toContain('terminal/create');
      expect(ACP_SERVER_REQUEST_ALIASES.createTerminal).toContain('terminalCreate');
    });

    it('has killTerminal aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.killTerminal).toContain('terminal/kill');
      expect(ACP_SERVER_REQUEST_ALIASES.killTerminal).toContain('terminalKill');
    });

    it('has releaseTerminal aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.releaseTerminal).toContain('terminal/release');
      expect(ACP_SERVER_REQUEST_ALIASES.releaseTerminal).toContain('terminalRelease');
    });

    it('has terminalOutput aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.terminalOutput).toContain('terminal/output');
      expect(ACP_SERVER_REQUEST_ALIASES.terminalOutput).toContain('terminalOutput');
    });

    it('has waitForTerminalExit aliases', () => {
      expect(ACP_SERVER_REQUEST_ALIASES.waitForTerminalExit).toContain('terminal/wait_for_exit');
      expect(ACP_SERVER_REQUEST_ALIASES.waitForTerminalExit).toContain('terminalWaitForExit');
    });
  });
});
