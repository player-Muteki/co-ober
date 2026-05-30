const en = {
  appName: 'Copsidian',
  appSubtitle: 'OpenCode Agent in Obsidian',

  welcome: {
    shortcuts: {
      enter: 'Enter  Send message',
      escape: 'Escape  Stop generation',
      at: '@  Reference a note',
      slash: '/  Slash commands',
    },
    connected: '● Connected',
    disconnected: '○ Disconnected',
    authMethodsHint: 'OpenCode reported available authentication methods:',
    authLoginCommand: 'Run `opencode auth login` in a terminal, then reconnect Copsidian.',
  },

  sessionDropdown: {
    forkDisabled: 'Fork is not supported by this OpenCode agent',
    resumeDisabled: 'Resume is not supported by this OpenCode agent',
    closeDisabled: 'Close is not supported by this OpenCode agent',
  },

  header: {
    new: 'New',
  },

  input: {
    placeholder: 'Type a message… (Enter to send, Shift+Enter for newline)',
  },

  session: {
    search: 'Search sessions…',
    empty: 'No sessions found',
    defaultTitle: 'Chat {time}',
  },

  reconnect: {
    text: 'Reconnect',
    connecting: 'Reconnecting…',
    failed: 'Reconnect (failed)',
  },

  newMessages: '↓ New messages',

  dragOverlay: 'Drop to attach',

  dragDrop: {
    imageNotSupported: 'This OpenCode agent does not support image prompts',
  },

  permission: {
    title: 'Permission: {title}',
    allowOnce: 'Allow Once',
    allowAlways: 'Allow Always',
    rejectOnce: 'Reject',
    rejectAlways: 'Reject Always',
  },

  error: {
    compact: 'Compact failed',
    timeout: 'Request timed out',
    processExit: 'OpenCode process exited',
    reconnected: 'Connection restored. The previous request was interrupted.',
  },

  message: {
    compacted: 'Session compacted.',
  },

  loading: {
    thinking: 'Thinking…',
  },

  copy: {
    button: 'Copy',
    copied: 'Copied',
  },

  thinking: {
    header: 'Thinking',
  },

  plan: {
    title: '📋 Plan',
  },

  slash: {
    compact: 'compact the session',
  },

  autocomplete: {
    noMatches: 'No matches',
  },

  toolbar: {
    send: 'Send',
    stop: 'Stop',
    modelTitle: 'Model',
    agentTitle: 'Agent mode',
    effortTitle: 'Thinking effort',
    noModels: 'No models',
    effort: {
      default: 'Default',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
    },
  },

  notice: {
    noSelection: 'No text selected',
    connected: 'Copsidian connected',
    connectFailed: 'Failed to connect to OpenCode',
  },

  usage: {
    model: 'Model',
    input: 'Input',
    output: 'Output',
    thinking: 'Thinking',
  },

  sync: {
    ruleFailed: 'Sync rule "{rule}" failed: {error}',
  },

  inlineEdit: {
    title: 'AI Edit Preview',
    apply: 'Apply',
    discard: 'Discard',
    prompt: 'Please edit and improve the following text. Respond with ONLY the edited text, no explanations:\n\n{text}',
  },

  acp: {
    processExited: 'OpenCode process exited with code {code}',
    unknownCode: 'unknown',
    stdinNotWritable: 'OpenCode process stdin is not writable',
    requestTimeout: 'Request timeout (5 minutes)',
  },

  settings: {
    connection: 'Connection',
    opencodePath: {
      name: 'OpenCode CLI Path',
      desc: 'Path to opencode executable (use "opencode" for PATH)',
      notFound: 'Warning: opencode path "{path}" not found',
    },
    reconnect: {
      name: 'Reconnect',
      desc: 'Re-establish connection to OpenCode',
      button: 'Reconnect',
      success: 'Reconnected',
      failed: 'Failed to reconnect',
    },
    autostart: {
      name: 'Auto-connect in Copsidian',
      desc: 'Connect to OpenCode from Copsidian user actions, never during Obsidian startup',
    },
    diagnostics: {
      heading: 'Diagnostics',
      description: 'Check the local OpenCode environment and Copsidian runtime metadata',
      run: 'Run Diagnostics',
      running: 'Running…',
      pass: 'Pass:',
      fail: 'Fail:',
      path: 'OpenCode CLI path',
      pathEmpty: 'OpenCode CLI path is empty',
      pathFound: 'Resolved "{path}"',
      connection: 'ACP connection',
      connectionOk: 'Connected to OpenCode',
      connectionFailed: 'Failed to connect to OpenCode',
      runtime: 'Runtime metadata',
      runtimeDetail: '{modes} agents, {models} models, {commands} commands',
      mcp: 'MCP servers',
      mcpDetail: '{enabled} enabled, {configured} configured',
      syncFolder: 'Default sync folder',
      syncFolderMissing: 'Default sync folder is empty',
      clientVersion: 'ACP client version',
      unexpectedError: 'Diagnostics failed unexpectedly',
    },
    agent: 'Agent',
    defaultAgent: 'Default Agent',
    defaultModel: 'Default Model',
    customAgents: {
      heading: 'Custom Agents',
      active: 'Active Custom Agent',
      activeDesc: 'Optional local agent instructions added to each chat request',
      none: 'None',
      add: '+ Add Custom Agent',
      label: 'Agent: {name}',
      defaultName: 'New Agent',
      enabled: 'Enabled',
      id: 'ID',
      idDesc: 'Stable local identifier used by settings and sessions',
      duplicateId: 'Custom agent ID already exists: {id}',
      name: 'Name',
      description: 'Description',
      instructions: 'Instructions',
      instructionsDesc: 'Prompt instructions injected when this agent is active',
      skills: 'Skill IDs',
      skillsDesc: 'Comma-separated IDs of enabled skills to include',
    },
    customSkills: {
      heading: 'Custom Skills',
      empty: 'No custom skills configured',
      loadedHeading: 'Loaded Skills',
      loading: 'Loading runtime skills…',
      loadedEmpty: 'No runtime skills loaded',
      add: '+ Add Custom Skill',
      label: 'Skill: {name}',
      defaultName: 'New Skill',
      enabled: 'Enabled',
      id: 'ID',
      idDesc: 'Stable local identifier referenced by custom agents',
      duplicateId: 'Custom skill ID already exists: {id}',
      name: 'Name',
      description: 'Description',
      instructions: 'Instructions',
      instructionsDesc: 'Reusable prompt instructions included by custom agents',
    },
    commonModels: {
      heading: 'Common Models',
      desc: 'Only selected models appear in the chat toolbar. Select none to show all models.',
      loading: 'Loading runtime models…',
      empty: 'No models loaded',
    },
    permissionMode: {
      name: 'Permission Mode',
      desc: 'Auto-approve behavior for tool permissions',
      yolo: 'Yolo — auto-approve all',
      plan: 'Plan — auto-approve safe',
      safe: 'Safe — confirm all',
    },
    systemPrompt: {
      heading: 'System Prompt',
      name: 'Custom System Prompt',
      desc: 'Additional instructions injected into the agent system prompt',
      placeholder: 'Enter custom system prompt instructions...',
    },
    notes: {
      heading: 'Notes & Context',
      defaultSyncFolder: 'Default Sync Folder',
      defaultSyncFolderDesc: 'Folder where sync notes are created',
      maxNoteSize: 'Max Note Reference Size',
      maxNoteSizeDesc: 'Maximum bytes when reading a referenced note (default 8000)',
      saved: 'Setting saved',
    },
    mcp: {
      heading: 'MCP Servers',
      add: '+ Add MCP Server',
      label: 'MCP: {name}',
      unnamed: 'Unnamed server',
      enabled: 'Enabled',
      name: 'Name',
      nameDesc: 'Unique server name passed to OpenCode',
      command: 'Command',
      commandDesc: 'Executable command, for example npx or uvx',
      args: 'Arguments',
      argsDesc: 'One argument per line',
      env: 'Environment Variables',
      envName: 'Name',
      envValue: 'Value',
      envAdd: '+ Add Variable',
    },
    mcpHttpDisabled: 'not supported by current agent',
    mcpSseDisabled: 'not supported by current agent',
    sync: {
      heading: 'Sync Rules',
      add: '+ Add Rule',
      label: 'Rule: {tool}',
      tool: 'Tool',
      folder: 'Folder',
      filenameTemplate: 'Filename Template',
      filenameTemplateDesc: 'Variables: {{tool}}, {{date}}, {{shortId}}',
      delete: 'Delete',
    },
    appearance: {
      heading: 'Appearance',
      language: 'Language',
      languageDesc: 'UI language',
      autoScroll: 'Auto-scroll',
      autoScrollDesc: 'Automatically scroll to bottom on new messages',
    },
    sessionLimits: {
      heading: 'Session Limits',
      maxMessages: 'Max Messages per Session',
      maxMessagesDesc: 'Truncate sessions when they exceed this limit (default 200)',
      retentionDays: 'Session Retention Days',
      retentionDaysDesc: 'Remove empty sessions older than this (default 30)',
    },
    fsCapability: {
      heading: 'File System Access',
      mode: 'FS Capability Mode',
      modeDesc: 'Control file system access for OpenCode agent',
      enabled: 'Read & Write — agent can read and write vault files',
      readonly: 'Read Only — agent can only read vault files',
      disabled: 'Disabled — no file system access',
    },
    terminalCapability: {
      heading: 'Terminal Access',
      mode: 'Terminal Capability Mode',
      modeDesc: 'Allow OpenCode agent to execute terminal commands',
      enabled: 'Enabled — agent can run commands',
      disabled: 'Disabled — no terminal access',
      timeout: 'Command Timeout (ms)',
      timeoutDesc: 'Maximum time in milliseconds before a command is terminated (default 30000)',
      maxOutput: 'Max Output Size (bytes)',
      maxOutputDesc: 'Maximum output buffer size in bytes (default 100000)',
    },
    idleTimeout: {
      name: 'Idle Timeout (ms)',
      desc: 'Maximum time to wait for agent response before timeout (default 300000, 0 to disable)',
    },
  },
};

export default en;
