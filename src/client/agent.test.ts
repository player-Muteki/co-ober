import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentRuntime } from './agent';
import { AcpTimeoutError } from './AcpErrors';
import type { AcpClient } from './acp';
import type { PermissionRequest, PermissionOption } from '../types';

describe('AgentRuntime', () => {
  let mockAcp: AcpClient;
  let runtime: AgentRuntime;

  const createRequest = (options: Array<{ optionId: string; kind: string }>): PermissionRequest => ({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'call-1', kind: 'edit', status: 'pending', title: 'Edit', rawInput: {}, locations: [] },
    options: options as PermissionOption[],
  });

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
      getSessionSnapshotFor: vi.fn().mockReturnValue({ messages: [] }),
      isSessionLoaded: vi.fn().mockReturnValue(true),
      activeStreamCount: vi.fn().mockReturnValue(0),
      getCurrentSessionId: vi.fn().mockReturnValue('session-1'),
      onClose: undefined,
      onReconnect: undefined,
      onPermissionRequest: undefined,
      // Mirrors AcpClient.setClientHandlers field assignment so the
      // runtime's delegation (which also syncs the live request handler)
      // stays observable here.
      setClientHandlers: vi.fn((h: any) => {
        mockAcp.onClose = h.onClose ?? undefined;
        mockAcp.onReconnect = h.onReconnect ?? undefined;
        mockAcp.onReconnectFailed = h.onReconnectFailed ?? undefined;
        mockAcp.onElicitationComplete = h.onElicitationComplete ?? undefined;
        mockAcp.onPermissionUnreadable = h.onPermissionUnreadable ?? undefined;
        mockAcp.onPermissionRequest = h.onPermissionRequest ?? undefined;
      }),
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
      expect(mockAcp.loadSession).toHaveBeenCalledWith('session-1', '/path', undefined, undefined);
    });

    it('loadSession forwards the replay handler', async () => {
      const onReplay = vi.fn();
      await runtime.loadSession('session-1', '/path', undefined, onReplay);
      expect(mockAcp.loadSession).toHaveBeenCalledWith('session-1', '/path', undefined, onReplay);
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
      expect(mockAcp.resumeSession).toHaveBeenCalledWith('session-1', '/path', undefined);
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

    it('getAgentProtocolVersion reads the version the handshake negotiated', () => {
      mockAcp.agentProtocolVersion = 2;
      expect(runtime.getAgentProtocolVersion()).toBe(2);
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

    it('getSessionSnapshotFor delegates to acp', () => {
      runtime.getSessionSnapshotFor('session-2');
      expect(mockAcp.getSessionSnapshotFor).toHaveBeenCalledWith('session-2');
    });

    it('isSessionLoaded delegates to acp', () => {
      runtime.isSessionLoaded('session-2');
      expect(mockAcp.isSessionLoaded).toHaveBeenCalledWith('session-2');
    });

    it('activeStreamCount delegates to acp', () => {
      runtime.activeStreamCount();
      expect(mockAcp.activeStreamCount).toHaveBeenCalled();
    });
  });

  describe('requestPermission', () => {
    it('yolo mode: returns allow_always option', async () => {
      runtime.permissionMode = 'yolo';
      const req = createRequest([
        { optionId: 'reject', kind: 'reject_once' },
        { optionId: 'allow_always', kind: 'allow_always' },
      ]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('allow_always');
    });

    it('yolo mode: prefers allow_once over a leading reject option', async () => {
      runtime.permissionMode = 'yolo';
      const req = createRequest([
        { optionId: 'reject', kind: 'reject_once' },
        { optionId: 'allow_once', kind: 'allow_once' },
      ]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('allow_once');
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

    it('readonly mode: auto-allows read, search and fetch tools', async () => {
      runtime.permissionMode = 'readonly';
      for (const kind of ['read', 'search', 'fetch'] as const) {
        const req = createRequest([
          { optionId: 'reject', kind: 'reject_once' },
          { optionId: 'allow', kind: 'allow_once' },
        ]);
        req.toolCall.kind = kind;

        const result = await runtime.requestPermission(req);
        expect(result).toBe('allow');
      }
    });

    it('readonly mode: rejects edit and execute tools', async () => {
      runtime.permissionMode = 'readonly';
      for (const kind of ['edit', 'execute', 'delete', 'move'] as const) {
        const req = createRequest([
          { optionId: 'allow_always', kind: 'allow_always' },
          { optionId: 'reject', kind: 'reject_once' },
        ]);
        req.toolCall.kind = kind;

        const result = await runtime.requestPermission(req);
        expect(result).toBe('reject');
      }
    });

    it('readonly mode: never falls back to an allow option when no reject exists', async () => {
      runtime.permissionMode = 'readonly';
      const req = createRequest([
        { optionId: 'allow', kind: 'allow_once' },
      ]);
      req.toolCall.kind = 'execute';

      const result = await runtime.requestPermission(req);
      // Synthesizing reject_once (which AcpRequestHandler turns into a
      // cancelled outcome) is correct; selecting the only allow option is not.
      expect(result).toBe('reject_once');
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

    it('safe mode: keeps a synthesized reject when no reject option exists', async () => {
      runtime.permissionMode = 'safe';
      const req = createRequest([
        { optionId: 'allow', kind: 'allow_once' },
      ]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('reject_once');
    });

    it('returns reject_once fallback when empty options', async () => {
      runtime.permissionMode = 'safe';
      const req = createRequest([]);

      const result = await runtime.requestPermission(req);
      expect(result).toBe('reject_once');
    });
  });

  describe('setClientHandlers', () => {
    it('sets handlers on acp and wraps the permission handler with a hold counter', async () => {
      const onClose = vi.fn();
      const onReconnect = vi.fn();
      const onReconnectFailed = vi.fn();
      const onPermissionRequest = vi.fn().mockResolvedValue('allow_once');

      runtime.setClientHandlers({ onClose, onReconnect, onReconnectFailed, onPermissionRequest });

      // Must delegate to AcpClient.setClientHandlers, the only path that
      // syncs the live AcpRequestHandler built during connect().
      expect(mockAcp.setClientHandlers).toHaveBeenCalledWith(
        expect.objectContaining({
          onClose,
          onReconnect,
          onReconnectFailed,
          onPermissionRequest: expect.any(Function),
        }),
      );
      expect(mockAcp.onClose).toBe(onClose);
      expect(mockAcp.onReconnect).toBe(onReconnect);
      expect(mockAcp.onReconnectFailed).toBe(onReconnectFailed);

      const wrapper = mockAcp.onPermissionRequest as unknown as (req: PermissionRequest) => Promise<string>;
      expect(typeof wrapper).toBe('function');
      const req = createRequest([]);
      const pending = wrapper(req);
      expect(Reflect.get(runtime, 'permissionHolds')).toBe(1);
      await expect(pending).resolves.toBe('allow_once');
      expect(onPermissionRequest).toHaveBeenCalledWith(req);
      expect(Reflect.get(runtime, 'permissionHolds')).toBe(0);
    });

    it('restores the hold counter when the permission handler throws', async () => {
      runtime.setClientHandlers({
        onPermissionRequest: vi.fn().mockRejectedValue(new Error('boom')),
      });

      const wrapper = mockAcp.onPermissionRequest as unknown as (req: PermissionRequest) => Promise<string>;
      await expect(wrapper(createRequest([]))).rejects.toThrow('boom');
      expect(Reflect.get(runtime, 'permissionHolds')).toBe(0);
    });

    it('sets default permission handler when not provided', () => {
      runtime.setClientHandlers({});

      expect(mockAcp.onClose).toBeUndefined();
      expect(mockAcp.onReconnect).toBeUndefined();
      expect(mockAcp.onReconnectFailed).toBeUndefined();
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
      // The idle timeout must also abort the underlying stream, otherwise the
      // next send fails with "A stream is already active".
      expect(mockAcp.cancel).toHaveBeenCalledWith('session-1');
      vi.useRealTimers();
      await promise.catch(() => {});
    });

    it('defers the idle timeout while a permission request is pending', async () => {
      vi.useFakeTimers();
      mockAcp.sendMessage = vi.fn().mockImplementation(() => new Promise(() => {}));
      mockAcp.cancel = vi.fn().mockResolvedValue(undefined);
      runtime.idleTimeoutMs = 10_000;
      let resolvePermission: (value: string) => void = () => {};
      runtime.setClientHandlers({
        onPermissionRequest: () => new Promise<string>((resolve) => { resolvePermission = resolve; }),
      });
      const wrapper = mockAcp.onPermissionRequest as unknown as (req: PermissionRequest) => Promise<string>;

      const promise = runtime.sendMessage('session-1', [{ type: 'text', text: 'Hello' }], vi.fn());
      // The timer fires inside advanceTimersByTimeAsync, before the rejects
      // assertion below can attach a handler; pre-attach one to keep it handled.
      promise.catch(() => {});
      const pendingPermission = wrapper(createRequest([]));

      // Three full windows pass with the banner open — none may kill the turn.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockAcp.cancel).not.toHaveBeenCalled();

      resolvePermission('allow_once');
      await pendingPermission;

      // After the release, one more full window and the turn times out.
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(promise).rejects.toBeInstanceOf(AcpTimeoutError);
      expect(mockAcp.cancel).toHaveBeenCalledWith('session-1');
      vi.useRealTimers();
      await promise.catch(() => {});
    });

    it('idleTimeoutMs <= 0 disables the timeout entirely', async () => {
      vi.useFakeTimers();
      mockAcp.sendMessage = vi.fn().mockImplementation(() => new Promise(() => {}));
      mockAcp.cancel = vi.fn().mockResolvedValue(undefined);
      runtime.idleTimeoutMs = 0;

      const promise = runtime.sendMessage('session-1', [{ type: 'text', text: 'Hello' }], vi.fn());
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(mockAcp.cancel).not.toHaveBeenCalled();

      const outcome = await Promise.race([
        promise.then(() => 'resolved', () => 'rejected'),
        Promise.resolve('pending'),
      ]);
      expect(outcome).toBe('pending');
      vi.useRealTimers();
    });
  });
});
