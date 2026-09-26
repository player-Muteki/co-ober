import type {
  PermissionRequest,
  PermissionDecision,
  CapabilityGrant,
  FsCapabilityMode,
  TerminalCapabilityMode,
  TerminalCreateParams,
  TerminalOutputResult,
  ElicitationField,
  ElicitationRequest,
  ElicitationAnswer,
} from '../types';
import type { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import { FsDelegate, type VaultWriteIo } from './fsDelegate';
import { TerminalManager, TerminalError } from './terminalManager';
import { z } from 'zod';
import { REQUEST_DEFAULT_TIMEOUT_MS, REQUEST_DEFAULT_MAX_OUTPUT_BYTES, UNREADABLE_SUMMARY_MAX_CHARS } from '../constants';
import { ACP_SERVER_REQUEST_ALIASES } from './AcpMethodNames';
import { zToolKind } from './acpSchemas';

// One dropped option is survivable; losing the whole request because a
// single field is malformed means the user never sees a prompt that was
// perfectly answerable. Strings degrade to '', bad options are dropped.
const zPermissionOption = z.object({
  optionId: z.string(),
  kind: z.string(),
  name: z.string(),
});
const zPermissionParams = z
  .object({
    sessionId: z.string().catch(''),
    toolCall: z
      .object({
        toolCallId: z.string().optional(),
        title: z.string().catch(''),
        status: z.string().optional(),
        rawInput: z.record(z.string(), z.unknown()).optional(),
        // An agent-minted kind we do not know must not cost the user the
        // whole prompt — degrade it to 'other'.
        kind: zToolKind.catch('other').optional(),
        locations: z.array(z.object({ path: z.string() })).optional(),
      })
      .passthrough(),
    // Permission-option kinds are an open set in practice (agents mint their
    // own); a strict enum here would fail the whole request and auto-cancel a
    // prompt the user never got to see. Accept any string and let the caller
    // match on the four known kinds for auto-decisions. A missing or
    // non-array options list degrades to empty; individual malformed options
    // are dropped rather than poisoning the array.
    options: z
      .array(z.unknown())
      .catch([])
      .transform((list) =>
        list.flatMap((o) => {
          const r = zPermissionOption.safeParse(o);
          return r.success ? [r.data] : [];
        }),
      ),
  })
  .passthrough();

const zFsPathParam = z.object({ path: z.string() });

const zElicitationParams = z
  .object({
    sessionId: z.string().optional(),
    mode: z.string().optional(),
    elicitationId: z.string().optional(),
    message: z.unknown().optional(),
    url: z.unknown().optional(),
    requestedSchema: z.unknown().optional(),
    schema: z.unknown().optional(),
  })
  .passthrough();

// ACP restricts elicitation properties to primitives. Everything here is
// lenient on purpose: one property we fail to read must cost that property's
// answer, not the whole question.
const zElicitationProperty = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  oneOf: z.array(z.object({ const: z.string(), title: z.string().optional() })).optional(),
});
const zElicitationSchema = z
  .object({
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).catch([]).optional(),
  })
  .catch({});

function elicitationField(
  key: string,
  raw: unknown,
  required: boolean,
): ElicitationField | null {
  const parsed = zElicitationProperty.safeParse(raw);
  if (!parsed.success) return null;
  const prop = parsed.data;
  const values =
    prop.oneOf?.map((option) => ({ value: option.const, label: option.title ?? option.const })) ??
    prop.enum?.map((value) => ({ value, label: value }));
  const base = { key, label: prop.title ?? key, required, ...(prop.description ? { description: prop.description } : {}) };
  if (values && values.length > 0) return { ...base, kind: 'enum' as const, values };
  if (prop.type === 'string') return { ...base, kind: 'text' as const };
  if (prop.type === 'number' || prop.type === 'integer') return { ...base, kind: 'number' as const };
  if (prop.type === 'boolean') return { ...base, kind: 'boolean' as const };
  return null;
}

/**
 * Split an elicitation schema into the fields this client can put an input
 * against and the keys it cannot. The second list exists so the reader sees a
 * partial answer coming; answering nothing at all is the failure this replaces.
 */
export function parseElicitationForm(raw: unknown): { fields: ElicitationField[]; omitted: string[] } {
  const parsed = zElicitationSchema.safeParse(raw);
  const properties = parsed.success ? parsed.data.properties : undefined;
  if (!properties) return { fields: [], omitted: [] };
  const required = new Set(parsed.success ? (parsed.data.required ?? []) : []);
  const fields: ElicitationField[] = [];
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const field = elicitationField(key, value, required.has(key));
    if (field) fields.push(field);
    else omitted.push(key);
  }
  return { fields, omitted };
}
const zFsWriteParam = z.object({
  path: z.string(),
  content: z.string(),
  // Required by the spec, and the only way a grant can be credited to the tab
  // whose agent asked for it. Agents that omit it still get the write.
  sessionId: z.string().optional(),
});
const zTerminalIdParam = z.object({ terminalId: z.string() });
const zTerminalCreateParam = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  sessionId: z.string().optional(),
});

export interface AcpRequestHandlerOptions {
  transport: AcpJsonRpcTransport;
  vaultPath: string;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  onElicitationRequest?: (req: ElicitationRequest) => Promise<ElicitationAnswer>;
  vaultIo?: VaultWriteIo;
  onPermissionUnreadable?: (summary: string) => void;
  onCapabilityGrant?: (grant: CapabilityGrant) => void;
}

export class AcpRequestHandler {
  private fsDelegate: FsDelegate | null = null;
  private fsCapabilityMode: FsCapabilityMode = 'enabled';
  private terminalManager: TerminalManager | null = null;
  private terminalCapabilityMode: TerminalCapabilityMode = 'enabled';
  private transport: AcpJsonRpcTransport;
  private vaultPath: string;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  onElicitationRequest?: (req: ElicitationRequest) => Promise<ElicitationAnswer>;
  onPermissionUnreadable?: (summary: string) => void;
  onCapabilityGrant?: (grant: CapabilityGrant) => void;

  constructor(options: AcpRequestHandlerOptions) {
    this.transport = options.transport;
    this.vaultPath = options.vaultPath;
    this.onPermissionRequest = options.onPermissionRequest;
    this.onElicitationRequest = options.onElicitationRequest;
    this.onPermissionUnreadable = options.onPermissionUnreadable;
    this.onCapabilityGrant = options.onCapabilityGrant;

    this.fsDelegate = new FsDelegate({
      vaultPath: this.vaultPath,
      maxBytes: 8000,
      vaultIo: options.vaultIo,
    });

    this.terminalManager = new TerminalManager({
      timeoutMs: REQUEST_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: REQUEST_DEFAULT_MAX_OUTPUT_BYTES,
    });

    this.registerHandlers();
  }

  private registerHandlers(): void {
    // Register every wire-name alias: dispatch in AcpJsonRpcTransport is
    // exact-match, and agents may send either the spec name
    // (session/request_permission) or the legacy bare name.
    this.registerServerRequest('requestPermission', (params) => {
      return this.handleServerRequestPermission(this.toRecord(params));
    });

    this.registerServerRequest('elicitationCreate', (params) => {
      return this.handleElicitationCreate(this.toRecord(params));
    });

    this.registerServerRequest('readTextFile', (params) => {
      return this.handleReadTextFile(this.toRecord(params));
    });

    this.registerServerRequest('writeTextFile', (params) => {
      return this.handleWriteTextFile(this.toRecord(params));
    });

    this.registerServerRequest('createTerminal', (params) => {
      return this.handleTerminalCreate(this.toRecord(params));
    });
    this.registerServerRequest('terminalOutput', (params) => {
      return this.handleTerminalOutput(this.toRecord(params));
    });
    this.registerServerRequest('killTerminal', (params) => {
      return this.handleTerminalKill(this.toRecord(params));
    });
    this.registerServerRequest('releaseTerminal', (params) => {
      return this.handleTerminalRelease(this.toRecord(params));
    });
    this.registerServerRequest('waitForTerminalExit', (params) => {
      return this.handleTerminalWaitForExit(this.toRecord(params));
    });
  }

  private registerServerRequest(
    logical: keyof typeof ACP_SERVER_REQUEST_ALIASES,
    handler: (params: unknown) => Promise<unknown>,
  ): void {
    for (const wireName of ACP_SERVER_REQUEST_ALIASES[logical]) {
      this.transport.onRequest(wireName, handler);
    }
  }

  private toRecord(params: unknown): Record<string, unknown> {
    const r = z.record(z.string(), z.unknown()).safeParse(params);
    return r.success ? r.data : {};
  }

  buildClientCapabilities(): Record<string, unknown> {
    const caps: Record<string, unknown> = {};
    if (this.fsCapabilityMode !== 'disabled') {
      caps.fs = {
        readTextFile: true,
        writeTextFile: this.fsCapabilityMode === 'enabled',
      };
    }
    if (this.terminalCapabilityMode === 'enabled') {
      caps.terminal = true;
    }
    // Form mode only: the banner renders the schema's scalar and enum fields
    // and answers with what the user typed. url mode is not advertised, though
    // a link an agent sends anyway is still shown rather than auto-accepted.
    caps.elicitation = { form: {} };
    return caps;
  }

  dispose(): void {
    this.terminalManager?.dispose();
    this.terminalManager = null;
    this.fsDelegate = null;
  }

  setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void {
    this.fsCapabilityMode = mode;
    if (this.fsDelegate && maxBytes !== undefined) {
      this.fsDelegate.setMaxBytes(maxBytes);
    }
  }

  setTerminalCapabilityMode(mode: TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void {
    this.terminalCapabilityMode = mode;
    if (this.terminalManager) {
      this.terminalManager.setConfig({ timeoutMs, maxOutputBytes });
    }
  }

  /**
   * Read a terminal this client hosts, for rendering rather than for the
   * agent's own terminal/output request. Null means the manager is gone
   * (disconnected or disposed).
   */
  readTerminal(terminalId: string): TerminalOutputResult | null {
    return this.terminalManager?.output(terminalId) ?? null;
  }

  private handleServerRequestPermission = (params: Record<string, unknown>): Promise<unknown> => {
    const parsed = zPermissionParams.safeParse(params);
    if (!parsed.success) {
      // A malformed request must not pass silently: the agent proceeds either
      // way, so the user needs to know the prompt they never saw was cancelled.
      const summary = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
        .slice(0, UNREADABLE_SUMMARY_MAX_CHARS);
      console.error('[co-ober] unreadable permission request, cancelling it:', summary);
      this.onPermissionUnreadable?.(summary);
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const req: PermissionRequest = {
      sessionId: parsed.data.sessionId,
      toolCall: parsed.data.toolCall as PermissionRequest['toolCall'],
      options: parsed.data.options,
    };

    // A prompt with nothing to click never resolves: the banner would sit
    // there while the idle timer re-arms forever. Cancel it on the wire and
    // tell the user, rather than hanging the turn.
    if (req.options.length === 0) {
      const summary = 'permission request carries no selectable options';
      console.error('[co-ober] unactionable permission request, cancelling it:', summary);
      this.onPermissionUnreadable?.(summary);
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }

    const handler = this.onPermissionRequest ?? ((r: PermissionRequest) => this.requestPermission(r));
    // Only report 'selected' when the agent actually offered that option id:
    // our fallbacks (dismissed banner, synthesized reject_once) must not
    // fabricate a choice the agent never presented — an unmatched decision
    // means "no selectable outcome", i.e. cancelled.
    const outcomeFor = (decision: PermissionDecision): unknown => {
      if (decision === null) {
        // Nobody answered (Esc, or a banner that went away). Say exactly that
        // rather than guessing at a reject option the user never saw.
        return { outcome: { outcome: 'cancelled' } };
      }
      if (parsed.data.options.some((o) => o.optionId === decision)) {
        return { outcome: { outcome: 'selected', optionId: decision } };
      }
      console.warn(`[co-ober] permission decision "${decision}" matches no offered option; reporting cancelled`);
      return { outcome: { outcome: 'cancelled' } };
    };
    return Promise.resolve(handler(req))
      .then(outcomeFor)
      .catch((error: unknown) => {
        // Only fall back to reject if the custom handler threw (e.g. programming error).
        // The default handler never throws.
        console.error('[co-ober] permission request handler failed, falling back to reject:', error);
        return Promise.resolve(this.requestPermission(req)).then(outcomeFor);
      });
  };

  private async requestPermission(req: PermissionRequest): Promise<string> {
    const reject = req.options.find((o) => o.kind === 'reject_once');
    return reject?.optionId ?? 'reject_once';
  }

  private handleElicitationCreate = (params: Record<string, unknown>): Promise<unknown> => {
    const parsed = zElicitationParams.safeParse(params);
    if (!parsed.success) {
      const summary = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
        .slice(0, UNREADABLE_SUMMARY_MAX_CHARS);
      console.error('[co-ober] unreadable elicitation request, cancelling it:', summary);
      this.onPermissionUnreadable?.(summary);
      return Promise.resolve({ action: 'cancel' });
    }

    const message = typeof parsed.data.message === 'string' ? parsed.data.message : '';
    const url = typeof parsed.data.url === 'string' ? parsed.data.url : '';
    const { fields, omitted } = parseElicitationForm(parsed.data.requestedSchema ?? parsed.data.schema);
    const req: ElicitationRequest = {
      sessionId: parsed.data.sessionId ?? '',
      elicitationId: parsed.data.elicitationId ?? `elicitation-${Date.now()}`,
      message,
      fields,
      omittedFields: omitted,
      ...(url ? { url } : {}),
    };

    // Nothing renderable means nobody can answer, and an accept with no content
    // would read back at the agent as a question the user chose to answer blank.
    // A url-mode request is different: accepting it reports the link was shown,
    // which is the whole of what this client does for that mode. A schema that
    // asks for no keys at all is a confirmation, and empty content is exactly
    // the answer to it.
    if (!req.url && fields.length === 0 && omitted.length > 0) {
      const summary = `elicitation asks for input Co-Ober cannot render (${omitted.join(', ')})`;
      console.error('[co-ober] unrenderable elicitation, declining it:', summary);
      this.onPermissionUnreadable?.(summary);
      return Promise.resolve({ action: 'decline' } satisfies ElicitationAnswer);
    }

    const handler = this.onElicitationRequest;
    if (!handler) {
      // No view is bound to answer: the honest reply is still "no answer",
      // never a silently empty form.
      console.warn('[co-ober] no elicitation handler is bound; declining');
      return Promise.resolve({ action: 'decline' } satisfies ElicitationAnswer);
    }

    return Promise.resolve(handler(req))
      .then((answer: ElicitationAnswer): ElicitationAnswer => {
        if (answer.action !== 'accept') return answer;
        // Echo only keys the agent actually asked for, so a caller that hands
        // back more than the schema requested cannot inject answers.
        const content: Record<string, string | number | boolean> = {};
        for (const field of fields) {
          const value = answer.content[field.key];
          if (value !== undefined) content[field.key] = value;
        }
        return { action: 'accept', content };
      })
      .catch((error: unknown) => {
        console.error('[co-ober] elicitation handler failed, cancelling:', error);
        return { action: 'cancel' } satisfies ElicitationAnswer;
      });
  };

  private handleReadTextFile(params: Record<string, unknown>): Promise<unknown> {
    // ACP's read result carries only `content`: an in-band {content:'',error}
    // would read back at the agent as a valid empty file, so failures must
    // travel as JSON-RPC errors (the transport maps throws to -32000).
    if (this.fsCapabilityMode === 'disabled' || !this.fsDelegate) {
      return Promise.reject(new Error('File system access is disabled'));
    }

    const parsed = zFsPathParam.safeParse(params);
    if (!parsed.success) {
      return Promise.reject(new Error('Missing required parameter: path'));
    }

    return Promise.resolve(this.fsDelegate.readTextFile(parsed.data.path)).then((res) => {
      if (res.error) throw new Error(res.error);
      return { content: res.content };
    });
  }

  private handleWriteTextFile(params: Record<string, unknown>): Promise<unknown> {
    // Same in-band trap as reads: {success:false} on an empty-result method
    // is indistinguishable from success at the agent.
    if (this.fsCapabilityMode !== 'enabled' || !this.fsDelegate) {
      return Promise.reject(new Error('File system write access is disabled'));
    }

    const parsed = zFsWriteParam.safeParse(params);
    if (!parsed.success) {
      return Promise.reject(new Error('Missing required parameter: path or content'));
    }

    return Promise.resolve(this.fsDelegate.writeTextFile(parsed.data.path, parsed.data.content)).then((res) => {
      if (res.error || !res.success) throw new Error(res.error ?? 'Write failed');
      // This write was never put in front of the user: the agent's own
      // permission prompt (if any) covered its tool call, not this client's
      // decision to let it reach the vault. Say what was touched.
      this.onCapabilityGrant?.({
        sessionId: parsed.data.sessionId,
        kind: 'file-write',
        detail: this.relativeToVault(parsed.data.path),
      });
      return { success: true };
    });
  }

  /** Show a path the way the user reads it in their own vault. */
  private relativeToVault(path: string): string {
    const prefix = `${this.vaultPath.replace(/[/\\]+$/, '')}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  private handleTerminalCreate(params: Record<string, unknown>): Promise<unknown> {
    if (this.terminalCapabilityMode !== 'enabled' || !this.terminalManager) {
      return Promise.resolve({ error: 'Terminal access is disabled' });
    }

    const parsed = zTerminalCreateParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: command' });
    }

    const createParams: TerminalCreateParams = {
      command: parsed.data.command,
      args: parsed.data.args,
      cwd: parsed.data.cwd,
      env: parsed.data.env,
    };

    try {
      const instance = this.terminalManager.create(createParams, this.vaultPath);
      // The allowlist is not a user decision: whatever this client let through
      // here ran without anyone being asked, so it has to be readable after the
      // fact — command and arguments included.
      this.onCapabilityGrant?.({
        sessionId: parsed.data.sessionId,
        kind: 'terminal',
        detail: [parsed.data.command, ...(parsed.data.args ?? [])].join(' '),
      });
      return Promise.resolve({
        terminalId: instance.terminalId,
        pid: instance.pid,
      });
    } catch (e) {
      const message =
        e instanceof TerminalError
          ? e.message
          : `Failed to create terminal: ${e instanceof Error ? e.message : String(e)}`;
      return Promise.resolve({ error: message });
    }
  }

  private handleTerminalOutput(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return Promise.resolve(this.terminalManager.output(parsed.data.terminalId)).then((res) => {
      // terminal/output's result is {output, truncated}; an in-band error
      // would be read as "the command printed nothing".
      if (res.error) throw new Error(res.error);
      return { output: res.output, truncated: res.truncated ?? false };
    });
  }

  private handleTerminalKill(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return Promise.resolve({ success: this.terminalManager.kill(parsed.data.terminalId) });
  }

  private handleTerminalRelease(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return Promise.resolve({ success: this.terminalManager.release(parsed.data.terminalId) });
  }

  private handleTerminalWaitForExit(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return this.terminalManager
      .waitForExit(parsed.data.terminalId)
      .then((result) => result ?? { error: 'Terminal not found' });
  }
}
