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
  },

  reconnect: {
    text: '重新连接',
    connecting: '连接中…',
    failed: '连接失败',
  },

  newMessages: '↓ 新消息',

  dragOverlay: '拖放以附加',

  permission: {
    title: '权限：{title}',
  },

  error: {
    compact: '压缩失败',
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
    effort: {
      default: '默认',
      low: '低',
      medium: '中',
      high: '高',
    },
  },
};

export default zh;
