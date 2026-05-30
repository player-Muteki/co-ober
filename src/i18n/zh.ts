import type { Locale } from './index';

const zh: Locale = {
  appName: 'Copsidian',
  appSubtitle: 'OpenCode Agent 在 Obsidian',

  welcome: {
    shortcuts: {
      enter: 'Enter 发送消息',
      escape: 'Escape 停止生成',
      at: '@ 引用笔记',
      slash: '/ 斜杠命令',
    },
    connected: '● 已连接',
    disconnected: '○ 未连接',
    authMethodsHint: 'OpenCode 返回了可用的认证方式：',
    authLoginCommand: '请在终端运行 `opencode auth login`，然后重新连接 Copsidian。',
  },

  sessionDropdown: {
    forkDisabled: '当前 OpenCode Agent 不支持分叉会话',
    resumeDisabled: '当前 OpenCode Agent 不支持恢复会话',
    closeDisabled: '当前 OpenCode Agent 不支持关闭会话',
  },

  header: {
    new: '新建',
  },

  input: {
    placeholder: '输入消息… (Enter 发送, Shift+Enter 换行)',
  },

  session: {
    search: '搜索会话…',
    empty: '未找到会话',
    defaultTitle: '会话 {time}',
  },

  reconnect: {
    text: '重新连接',
    connecting: '连接中…',
    failed: '连接失败',
  },

  newMessages: '↓ 新消息',

  dragOverlay: '拖放以附加',

  dragDrop: {
    imageNotSupported: '当前 OpenCode Agent 不支持图片提示词',
  },

  permission: {
    title: '权限：{title}',
    allowOnce: '允许一次',
    allowAlways: '总是允许',
    rejectOnce: '拒绝',
    rejectAlways: '总是拒绝',
  },

  error: {
    compact: '压缩失败',
    timeout: '请求超时',
    processExit: 'OpenCode 进程已退出',
    reconnected: '连接已恢复，之前的请求已中断。',
  },

  message: {
    compacted: '会话已压缩。',
  },

  loading: {
    thinking: '思考中…',
  },

  copy: {
    button: '复制',
    copied: '已复制',
  },

  thinking: {
    header: '思考',
  },

  plan: {
    title: '📋 计划',
  },

  slash: {
    compact: '压缩会话',
  },

  autocomplete: {
    noMatches: '无匹配',
  },

  toolbar: {
    send: '发送',
    stop: '停止',
    modelTitle: '模型',
    agentTitle: 'Agent 模式',
    effortTitle: '思考强度',
    noModels: '无可用模型',
    effort: {
      default: '默认',
      low: '低',
      medium: '中',
      high: '高',
    },
  },

  notice: {
    noSelection: '未选择文本',
    connected: 'Copsidian 已连接',
    connectFailed: '连接 OpenCode 失败',
  },

  usage: {
    model: '模型',
    input: '输入',
    output: '输出',
    thinking: '思考',
  },

  sync: {
    ruleFailed: '同步规则“{rule}”失败：{error}',
  },

  inlineEdit: {
    title: 'AI 编辑预览',
    apply: '应用',
    discard: '放弃',
    prompt: '请编辑并改进以下文本。只返回编辑后的文本，不要解释：\n\n{text}',
  },

  acp: {
    processExited: 'OpenCode 进程已退出，退出码：{code}',
    unknownCode: '未知',
    stdinNotWritable: 'OpenCode 进程 stdin 不可写',
    requestTimeout: '请求超时（5 分钟）',
  },

  settings: {
    connection: '连接',
    opencodePath: {
      name: 'OpenCode CLI 路径',
      desc: 'opencode 可执行文件路径（使用 "opencode" 表示从 PATH 查找）',
      notFound: '警告：未找到 opencode 路径 "{path}"',
    },
    reconnect: {
      name: '重新连接',
      desc: '重新建立与 OpenCode 的连接',
      button: '重新连接',
      success: '已重新连接',
      failed: '重新连接失败',
    },
    autostart: {
      name: '在 Copsidian 中自动连接',
      desc: '仅在 Copsidian 用户操作时连接 OpenCode，不在 Obsidian 启动时连接',
    },
    diagnostics: {
      heading: '诊断',
      description: '检查本地 OpenCode 环境和 Copsidian 运行时元数据',
      run: '运行诊断',
      running: '诊断中…',
      pass: '通过：',
      fail: '失败：',
      path: 'OpenCode CLI 路径',
      pathEmpty: 'OpenCode CLI 路径为空',
      pathFound: '已解析 "{path}"',
      connection: 'ACP 连接',
      connectionOk: '已连接到 OpenCode',
      connectionFailed: '连接 OpenCode 失败',
      runtime: '运行时元数据',
      runtimeDetail: '{modes} 个 Agent，{models} 个模型，{commands} 个命令',
      mcp: 'MCP 服务器',
      mcpDetail: '已启用 {enabled} 个，已配置 {configured} 个',
      syncFolder: '默认同步文件夹',
      syncFolderMissing: '默认同步文件夹为空',
      clientVersion: 'ACP 客户端版本',
      unexpectedError: '诊断意外失败',
    },
    agent: 'Agent',
    defaultAgent: '默认 Agent',
    defaultModel: '默认模型',
    customAgents: {
      heading: '自定义 Agent',
      active: '当前自定义 Agent',
      activeDesc: '可选的本地 Agent 指令，会加入每次对话请求',
      none: '无',
      add: '+ 添加自定义 Agent',
      label: 'Agent：{name}',
      defaultName: '新 Agent',
      enabled: '启用',
      id: 'ID',
      idDesc: '设置和会话引用的稳定本地标识',
      duplicateId: '自定义 Agent ID 已存在：{id}',
      name: '名称',
      description: '描述',
      instructions: '指令',
      instructionsDesc: '此 Agent 启用时注入的提示词指令',
      skills: '技能 ID',
      skillsDesc: '用英文逗号分隔要包含的已启用技能 ID',
    },
    customSkills: {
      heading: '自定义技能',
      empty: '暂无自定义技能',
      loadedHeading: '已载入技能',
      loading: '正在载入运行时技能…',
      loadedEmpty: '未载入运行时技能',
      add: '+ 添加自定义技能',
      label: '技能：{name}',
      defaultName: '新技能',
      enabled: '启用',
      id: 'ID',
      idDesc: '自定义 Agent 引用的稳定本地标识',
      duplicateId: '自定义技能 ID 已存在：{id}',
      name: '名称',
      description: '描述',
      instructions: '指令',
      instructionsDesc: '由自定义 Agent 复用的提示词指令',
    },
    commonModels: {
      heading: '常用模型',
      desc: '只有选中的模型会出现在聊天工具栏。不选择则显示全部模型。',
      loading: '正在载入运行时模型…',
      empty: '未载入模型',
    },
    permissionMode: {
      name: '权限模式',
      desc: '工具权限的自动批准行为',
      yolo: 'Yolo — 全部自动批准',
      plan: 'Plan — 自动批准安全操作',
      safe: 'Safe — 全部确认',
    },
    systemPrompt: {
      heading: '系统提示词',
      name: '自定义系统提示词',
      desc: '注入 Agent 的额外指令',
      placeholder: '输入自定义系统提示词...',
    },
    notes: {
      heading: '笔记与上下文',
      defaultSyncFolder: '默认同步文件夹',
      defaultSyncFolderDesc: '同步笔记的创建位置',
      maxNoteSize: '最大笔记引用大小',
      maxNoteSizeDesc: '读取引用笔记时的最大字节数（默认 8000）',
      saved: '设置已保存',
    },
    mcp: {
      heading: 'MCP 服务器',
      add: '+ 添加 MCP 服务器',
      label: 'MCP：{name}',
      unnamed: '未命名服务器',
      enabled: '启用',
      name: '名称',
      nameDesc: '传递给 OpenCode 的唯一服务器名称',
      command: '命令',
      commandDesc: '可执行命令，例如 npx 或 uvx',
      args: '参数',
      argsDesc: '每行一个参数',
      env: '环境变量',
      envName: '名称',
      envValue: '值',
      envAdd: '+ 添加变量',
    },
    mcpHttpDisabled: '当前 Agent 不支持',
    mcpSseDisabled: '当前 Agent 不支持',
    sync: {
      heading: '同步规则',
      add: '+ 添加规则',
      label: '规则：{tool}',
      tool: '工具',
      folder: '文件夹',
      filenameTemplate: '文件名模板',
      filenameTemplateDesc: '变量：{{tool}}、{{date}}、{{shortId}}',
      delete: '删除',
    },
    appearance: {
      heading: '外观',
      language: '语言',
      languageDesc: '界面语言',
      autoScroll: '自动滚动',
      autoScrollDesc: '有新消息时自动滚动到底部',
    },
    sessionLimits: {
      heading: '会话限制',
      maxMessages: '每个会话最大消息数',
      maxMessagesDesc: '会话超过此限制时自动截断（默认 200）',
      retentionDays: '会话保留天数',
      retentionDaysDesc: '移除超过此天数的空会话（默认 30）',
    },
    fsCapability: {
      heading: '文件系统访问',
      mode: 'FS 能力模式',
      modeDesc: '控制 OpenCode Agent 的文件系统访问权限',
      enabled: '读写 — Agent 可以读写 Vault 文件',
      readonly: '只读 — Agent 只能读取 Vault 文件',
      disabled: '禁用 — 无文件系统访问权限',
    },
    terminalCapability: {
      heading: '终端访问',
      mode: '终端能力模式',
      modeDesc: '允许 OpenCode Agent 执行终端命令',
      enabled: '启用 — Agent 可以运行命令',
      disabled: '禁用 — 无终端访问权限',
      timeout: '命令超时（毫秒）',
      timeoutDesc: '命令终止前的最大等待时间（默认 30000）',
      maxOutput: '最大输出大小（字节）',
      maxOutputDesc: '输出缓冲区的最大字节数（默认 100000）',
    },
    idleTimeout: {
      name: '空闲超时（毫秒）',
      desc: '等待 Agent 响应的最大时间（默认 300000，设为 0 禁用）',
    },
  },
};

export default zh;
