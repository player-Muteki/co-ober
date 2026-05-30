export type AcpLogicalMethod =
  | 'initialize'
  | 'authenticate'
  | 'newSession'
  | 'loadSession'
  | 'listSessions'
  | 'prompt'
  | 'cancel'
  | 'setMode'
  | 'setConfigOption'
  | 'closeSession'
  | 'forkSession'
  | 'resumeSession'
  | 'setModel';

const ACP_METHOD_CANDIDATES: Record<AcpLogicalMethod, readonly string[]> = {
  initialize: ['initialize'],
  authenticate: ['authenticate'],
  newSession: ['session/new', 'newSession'],
  loadSession: ['session/load', 'loadSession'],
  listSessions: ['session/list', 'listSessions'],
  prompt: ['session/prompt', 'prompt'],
  cancel: ['session/cancel', 'cancel'],
  setMode: ['session/set_mode', 'setSessionMode'],
  setConfigOption: ['session/set_config_option', 'setSessionConfigOption'],
  closeSession: ['session/close', 'closeSession'],
  forkSession: ['session/unstable_fork', 'forkSession'],
  resumeSession: ['session/resume', 'resumeSession'],
  setModel: ['session/set_model', 'setSessionModel'],
} as const;

export const ACP_SERVER_NOTIFICATION_ALIASES = {
  sessionUpdate: ['session/update', 'sessionUpdate'],
} as const;

export const ACP_SERVER_REQUEST_ALIASES = {
  requestPermission: ['session/request_permission', 'requestPermission'],
  readTextFile: ['fs/read_text_file', 'fs/readTextFile'],
  writeTextFile: ['fs/write_text_file', 'fs/writeTextFile'],
  createTerminal: ['terminal/create', 'terminalCreate'],
  killTerminal: ['terminal/kill', 'terminalKill'],
  releaseTerminal: ['terminal/release', 'terminalRelease'],
  terminalOutput: ['terminal/output', 'terminalOutput'],
  waitForTerminalExit: ['terminal/wait_for_exit', 'terminalWaitForExit'],
} as const;

export function getAcpMethodCandidates(logicalMethod: AcpLogicalMethod): readonly string[] {
  return ACP_METHOD_CANDIDATES[logicalMethod];
}
