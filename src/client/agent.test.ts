import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentRuntime } from './agent';
import type { AcpClient } from './acp';
import type { PermissionRequest, PermissionOption } from '../types';

describe('AgentRuntime', () => {
  let mockAcp: AcpClient;
  let runtime: AgentRuntime;

  beforeEach(() => {
    mockAcp = {
      isConnected: vi.fn().mockReturnValue(true),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue('session-1'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
      closeSession: vi.fn().mockResolvedValue(undefined),
      forkSession: vi.fn().mockResolvedValue('session-2'),
      resumeSession: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      setConfigOption: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue(undefined),
      getAgentCapabilities: vi.fn().mockReturnValue(null),
      getAvailableAgents: vi.fn().mockResolvedValue([]),
      getAvailableModels: vi.fn().mockResolvedValue([]),
      getAvailableCommands: vi.fn().mockResolvedValue([]),
      getSessionInfo: vi.fn().mockReturnValue(null),
      getSessionSnapshot: vi.fn().mockReturnValue({ messages: [] }),
      getCurrentSessionId: vi.fn().mockReturnValue('session-1'),
      onClose: undefined,
      onReconnect: undefined,
      onPermissionRequest: undefined,
    } as any;
    runtime = new AgentRuntime(mockAcp);
  });

  describe('delegation to AcpClient', () => {
    it('isConnected delegates to acp', () => {
      expect(runtime.isConnected()).toBe(true);
      expect(mockAcp.isConnected).toHaveBeenCalled();
    });

    it('connect delegates to acp', async () => {
      await runtime.connect();
      expect(mockAcp.connect).toHaveBeenCalled();
    });

    it('disconnect delegates to acp', async () => {
      await runtime.disconnect();
      expect(mockAcp.disconnect).toHaveBeenCalled();
    });

    it('createSession delegates to acp', async () => {
      const id = await runtime.createSession('/path');
      expect(id).toBe('session-1');
      expect(mockAcp.createSession).toHaveBeenCalledWith('/path', undefined);
    });

    it('loadSession delegates to acp', async () => {
      await runtime.loadSession('session-1', '/path');
      expect(mockAcp.loadSession).toHaveBeenCalledWith('session-1', '/path', undefined);
    });

    it('listSessions delegates to acp', async () => {
      await runtime.listSessions('/path');
      expect(mockAcp.listSessions).toHaveBeenCalledWith('/path');
    });

    it('closeSession delegates to acp', async () => {
      await runtime.closeSession('session-1');
      expect(mockAcp.closeSession).toHaveBeenCalledWith('session-1');
    });

    it('forkSession delegates to acp', async () => {
      const id = await runtime.forkSession('session-1', '/path');
      expect(id).toBe('session-2');
      expect(mockAcp.forkSession).toHaveBeenCalledWith('session-1', '/path');
    });

    it('resumeSession delegates to acp', async () => {
      await runtime.resumeSession('session-1', '/path');
      expect(mockAcp.resumeSession).toHaveBeenCalledWith('session-1', '/path');
    });

    it('setMode delegates to acp', async () => {
      await runtime.setMode('session-1', 'coding');
      expect(mockAcp.setMode).toHaveBeenCalledWith('session-1', 'coding');
    });

    it('setModel delegates to acp', async () => {
      await runtime.setModel('session-1', 'claude-3');
      expect(mockAcp.setModel).toHaveBeenCalledWith('session-1', 'claude-3');
    });

    it('setConfigOption delegates to acp', async () => {
      await runtime.setConfigOption('session-1', 'effort', 'high');
      expect(mockAcp.setConfigOption).toHaveBeenCalledWith('session-1', 'effort', 'high');
    });

    it('cancel delegates to acp', async () => {
      await runtime.cancel('session-1');
      expect(mockAcp.cancel).toHaveBeenCalledWith('session-1');
    });

    it('getAgentCapabilities delegates to acp', () => {
      runtime.getAgentCapabilities();
      expect(mockAcp.getAgentCapabilities).toHaveBeenCalled();
    });

    it('getAvailableAgents delegates to acp', async () => {
      await runtime.getAvailableAgents();
      expect(mockAcp.getAvailableAgents).toHaveBeenCalled();
    });

    it('getAvailableModels delegates to acp', async () => {
      await runtime.getAvailableModels();
      expect(mockAcp.getAvailableModels).toHaveBeenCalled();
    });

    it('getAvailableCommands delegates to acp', async () => {
      await runtime.getAvailableCommands();
      expect(mockAcp.getAvailableCommands).toHaveBeenCalled();
    });

    it('getSessionInfo delegates to acp', () => {
      runtime.getSessionInfo();
      expect(mockAcp.getSessionInfo).toHaveBeenCalled();
    });

    it('getSessionSnapshot delegates to acp', () => {
      runtime.getSessionSnapshot();
      expect(mockAcp.getSessionSnapshot).toHaveBeenCalled();
    });

    it('getCurrentSessionId delegates to acp', () => {
      runtime.getCurrentSessionId();
      expect(mockAcp.getCurrentSessionId).toHaveBeenCalled();
    });
  });

  describe('requestPermission', () => {
    const createRequest = (options: Array<{ optionId: string; kind: string }>): PermissionRequest => ({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-1', kind: 'edit', status: 'pending', title: 'Edit', rawInput: {}, locations: [] },
      options: options as PermissionOption[],
    });

    it('yolo mode: returns allow_always option', async () => {
      runtime.permissionMode = 'yolo';
      const req = createRequest([
        { optionId: 'reject', kind: 'reject_once' },
        { optionId: 'allow_always', kind: 'allow_always' },
      ]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('allow_always');
    });

    it('yolo mode: returns first option when no allow_always', async () => {
      runtime.permissionMode = 'yolo';
      const req = createRequest([
        { optionId: 'reject', kind: 'reject_once' },
        { optionId: 'allow_once', kind: 'allow_once' },
      ]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('reject');
    });

    it('yolo mode: returns allow_once fallback', async () => {
      runtime.permissionMode = 'yolo';
      const req = createRequest([]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('allow_once');
    });

    it('plan mode: auto-allows read tools', async () => {
      runtime.permissionMode = 'plan';
      const req = createRequest([
        { optionId: 'reject', kind: 'reject_once' },
        { optionId: 'allow', kind: 'allow_once' },
      ]);
      req.toolCall.kind = 'read';

      const result = await runtime.requestPermission(req);
      expect(result).toBe('allow');
    });

    it('plan mode: auto-allows search tools', async () => {
      runtime.permissionMode = 'plan';
      const req = createRequest([
        { optionId: 'allow_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ]);
      req.toolCall.kind = 'search';

      const result = await runtime.requestPermission(req);
      expect(result).toBe('allow_always');
    });

    it('plan mode: rejects non-read/search tools', async () => {
      runtime.permissionMode = 'plan';
      const req = createRequest([
        { optionId: 'allow', kind: 'allow_once' },
        { optionId: 'reject_always', kind: 'reject_always' },
      ]);
      req.toolCall.kind = 'edit';

      const result = await runtime.requestPermission(req);
      expect(result).toBe('reject_always');
    });

    it('safe mode: rejects by default', async () => {
      runtime.permissionMode = 'safe';
      const req = createRequest([
        { optionId: 'allow', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('reject');
    });

    it('safe mode: returns first option when no reject', async () => {
      runtime.permissionMode = 'safe';
      const req = createRequest([
        { optionId: 'allow', kind: 'allow_once' },
      ]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('allow');
    });

    it('returns reject_once fallback when empty options', async () => {
      runtime.permissionMode = 'safe';
      const req = createRequest([]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('reject_once');
    });
  });

  describe('setClientHandlers', () => {
    it('sets handlers on acp', () => {
      const onClose = vi.fn();
      const onReconnect = vi.fn();
      const onPermissionRequest = vi.fn();

      runtime.setClientHandlers({ onClose, onReconnect, onPermissionRequest });

      expect(mockAcp.onClose).toBe(onClose);
      expect(mockAcp.onReconnect).toBe(onReconnect);
      expect(mockAcp.onPermissionRequest).toBe(onPermissionRequest);
    });

    it('sets default permission handler when not provided', () => {
      runtime.setClientHandlers({});

      expect(mockAcp.onClose).toBeUndefined();
      expect(mockAcp.onReconnect).toBeUndefined();
      expect(mockAcp.onPermissionRequest).toBeDefined();
    });
  });

  describe('sendMessage', () => {
    it('sends message and resolves with response', async () => {
      const handler = vi.fn();
      const response = await runtime.sendMessage('session-1', [{ type: 'text', text: 'Hello' }], handler);

      expect(response).toEqual({ stopReason: 'end_turn' });
      expect(mockAcp.sendMessage).toHaveBeenCalledWith('session-1', [{ type: 'text', text: 'Hello' }], expect.any(Function));
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();
      mockAcp.sendMessage = vi.fn().mockImplementation(() => new Promise(() => {})); // Never resolves
      mockAcp.cancel = vi.fn().mockResolvedValue(undefined);

      const handler = vi.fn();
      const promise = runtime.sendMessage('session-1', [{ type: 'text', text: 'Hello' }], handler);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await expect(promise).rejects.toThrow();
      vi.useRealTimers();
    });
  });
});
