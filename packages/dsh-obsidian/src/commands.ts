/**
 * Obsidian CLI 命令分类定义。
 *
 * 数据源:Obsidian 内置 CLI(obsidian <command> [options])。
 * 参考 https://obsidian.md/zh/help/cli(官方)+ 社区命令参考。
 * 我们只声明本插件要导出的命令族,不穷举所有子命令 — 子命令集合
 * 由本表为单一真源,供以下三处复用:
 *   1. runner(argv 拼接);
 *   2. system-prompt section(自动渲染命令表);
 *   3. README(自动生成命令清单,避免双写漂移)。
 *
 * 约定:
 * - `name` 与 Obsidian CLI 子命令字面一致(冒号语法 `daily:read` 也保留);
 * - `params` 按 Obsidian CLI 的实际拼装顺序排列,以便生成的 `key=value` 串
 *   与官方文档示例一致(便于人工对照);
 * - `description` 简短中文,供 model 看的语义;
 * - `danger` 决定协议层是否要求 agent 二次确认(详见 types.ts)。
 */

import type { ObsidianCommandSpec } from './types.ts';

/** 本插件导出的全部 Obsidian CLI 命令清单(单一真源)。 */
export const OBSIDIAN_COMMANDS: readonly ObsidianCommandSpec[] = [
  // ── file 族(读 + 写 + 列表) ─────────────────────────────────────
  {
    name: 'read',
    family: 'file',
    danger: 'read',
    description: '读取指定笔记的正文。',
    params: [
      {
        name: 'path',
        required: true,
        description: 'vault 内相对路径(不含 .md 后缀)。',
      },
    ],
  },
  {
    name: 'create',
    family: 'file',
    danger: 'write',
    description:
      '创建一篇新笔记;已存在时按协议失败(需带 overwrite 标志才覆盖)。',
    params: [
      { name: 'path', required: true, description: 'vault 内相对路径。' },
      {
        name: 'content',
        required: true,
        description: '笔记正文(支持 Markdown)。',
      },
      {
        name: 'overwrite',
        required: false,
        description: '存在时覆盖(布尔标志;本插件用 `overwrite=true` 触发)。',
      },
    ],
  },
  {
    name: 'append',
    family: 'file',
    danger: 'write',
    description: '向现有笔记末尾追加内容。',
    params: [
      { name: 'path', required: true, description: 'vault 内相对路径。' },
      { name: 'content', required: true, description: '追加的正文。' },
    ],
  },
  {
    name: 'prepend',
    family: 'file',
    danger: 'write',
    description: '向现有笔记开头插入内容。',
    params: [
      { name: 'path', required: true, description: 'vault 内相对路径。' },
      { name: 'content', required: true, description: '插入的正文。' },
    ],
  },
  {
    name: 'delete',
    family: 'file',
    danger: 'destructive',
    description: '删除一篇笔记;默认进 Obsidian 回收站,带 `permanent` 时硬删。',
    params: [
      { name: 'path', required: true, description: 'vault 内相对路径。' },
      {
        name: 'permanent',
        required: false,
        description: '永久删除标志(本插件用 `permanent=true` 触发)。',
      },
    ],
  },
  {
    name: 'file:move',
    family: 'file',
    danger: 'write',
    description: '移动或重命名笔记。',
    params: [
      { name: 'path', required: true, description: '源路径。' },
      { name: 'to', required: true, description: '目标路径。' },
    ],
  },
  {
    name: 'file',
    family: 'file',
    danger: 'read',
    description: '查看指定笔记的元信息(大小、创建时间、链接等)。',
    params: [
      { name: 'path', required: true, description: 'vault 内相对路径。' },
    ],
  },
  {
    name: 'files',
    family: 'file',
    danger: 'read',
    description: '列出 vault 内文件,可按文件夹或扩展名过滤。',
    params: [
      { name: 'folder', required: false, description: '限定子文件夹(可选)。' },
      {
        name: 'ext',
        required: false,
        description: '限定扩展名,如 `md`(可选)。',
      },
    ],
  },

  // ── daily 族(日常笔记) ──────────────────────────────────────────
  {
    name: 'daily:read',
    family: 'daily',
    danger: 'read',
    description: '读取今日 daily note 正文。',
    params: [],
  },
  {
    name: 'daily:append',
    family: 'daily',
    danger: 'write',
    description: '向今日 daily note 末尾追加内容。',
    params: [{ name: 'content', required: true, description: '追加的正文。' }],
  },
  {
    name: 'daily:prepend',
    family: 'daily',
    danger: 'write',
    description: '向今日 daily note 开头插入内容。',
    params: [{ name: 'content', required: true, description: '插入的正文。' }],
  },
  {
    name: 'daily:path',
    family: 'daily',
    danger: 'read',
    description: '查询今日 daily note 的路径(用于其它工具二次引用)。',
    params: [],
  },
  {
    name: 'daily',
    family: 'daily',
    danger: 'read',
    description:
      '在 Obsidian 应用中打开今日 daily note(UI 副作用,严格说不算只读)。',
    params: [],
  },

  // ── search 族(搜索 + 标签) ──────────────────────────────────────
  {
    name: 'search',
    family: 'search',
    danger: 'read',
    description: '在 vault 内搜索关键词,返回匹配行。',
    params: [
      { name: 'query', required: true, description: '搜索关键词或正则。' },
      { name: 'path', required: false, description: '限定子文件夹(可选)。' },
    ],
  },
  {
    name: 'search:context',
    family: 'search',
    danger: 'read',
    description: '搜索并返回匹配行的上下文(前后各若干行)。',
    params: [
      { name: 'query', required: true, description: '搜索关键词或正则。' },
    ],
  },
  {
    name: 'search:open',
    family: 'search',
    danger: 'write',
    description: '在 Obsidian 应用中打开搜索面板(UI 副作用)。',
    params: [{ name: 'query', required: true, description: '搜索关键词。' }],
  },
  {
    name: 'tags',
    family: 'search',
    danger: 'read',
    description: '列出 vault 内的标签;带 `counts` 时附加每个标签的出现次数。',
    params: [
      { name: 'file', required: false, description: '限定单一文件(可选)。' },
      {
        name: 'counts',
        required: false,
        description: '是否统计出现次数(布尔标志)。',
      },
    ],
  },

  // ── property 族(front-matter 属性) ──────────────────────────────
  {
    name: 'property:read',
    family: 'property',
    danger: 'read',
    description: '读取指定笔记的某条 front-matter 属性。',
    params: [
      { name: 'name', required: true, description: '属性名。' },
      { name: 'path', required: true, description: '笔记路径。' },
    ],
  },
  {
    name: 'property:set',
    family: 'property',
    danger: 'write',
    description: '设置/覆盖指定笔记的某条 front-matter 属性。',
    params: [
      { name: 'name', required: true, description: '属性名。' },
      {
        name: 'value',
        required: true,
        description: '属性值(字符串;复杂类型走 serialize)。',
      },
      { name: 'path', required: true, description: '笔记路径。' },
    ],
  },
  {
    name: 'property:remove',
    family: 'property',
    danger: 'write',
    description: '删除指定笔记的某条 front-matter 属性。',
    params: [
      { name: 'name', required: true, description: '属性名。' },
      { name: 'path', required: true, description: '笔记路径。' },
    ],
  },
  {
    name: 'properties',
    family: 'property',
    danger: 'read',
    description:
      '列出指定笔记的所有 front-matter 属性(或全文搜索时显示全局统计)。',
    params: [
      { name: 'file', required: false, description: '限定单一文件(可选)。' },
    ],
  },

  // ── plugin / snippet 族(插件与 CSS 片段) ─────────────────────────
  {
    name: 'plugin:enable',
    family: 'plugin-snippet',
    danger: 'write',
    description: '启用指定 Obsidian 社区插件(按 id)。',
    params: [
      {
        name: 'id',
        required: true,
        description: '插件 id(社区插件目录中的唯一标识)。',
      },
    ],
  },
  {
    name: 'plugin:disable',
    family: 'plugin-snippet',
    danger: 'destructive',
    description: '禁用指定 Obsidian 社区插件(可能影响用户工作流)。',
    params: [{ name: 'id', required: true, description: '插件 id。' }],
  },
  {
    name: 'plugin:reload',
    family: 'plugin-snippet',
    danger: 'write',
    description: '热重载指定 Obsidian 社区插件(常用于开发期)。',
    params: [{ name: 'id', required: true, description: '插件 id。' }],
  },
  {
    name: 'plugins',
    family: 'plugin-snippet',
    danger: 'read',
    description: '列出已安装的 Obsidian 社区插件。',
    params: [],
  },
  {
    name: 'snippet:enable',
    family: 'plugin-snippet',
    danger: 'write',
    description: '启用指定 CSS snippet。',
    params: [
      {
        name: 'name',
        required: true,
        description: 'snippet 文件名(不含 .css)。',
      },
    ],
  },
  {
    name: 'snippet:disable',
    family: 'plugin-snippet',
    danger: 'destructive',
    description: '禁用指定 CSS snippet。',
    params: [
      {
        name: 'name',
        required: true,
        description: 'snippet 文件名(不含 .css)。',
      },
    ],
  },
  {
    name: 'snippets',
    family: 'plugin-snippet',
    danger: 'read',
    description: '列出已安装的 CSS snippet。',
    params: [],
  },

  // ── command 族(Obsidian 应用内命令面板) ──────────────────────────
  {
    name: 'command',
    family: 'command',
    danger: 'execute',
    description:
      '在 Obsidian 应用进程内执行任意命令面板命令(行为未知,走宿主权限闸)。',
    params: [
      {
        name: 'id',
        required: true,
        description: 'Obsidian 命令 id(由 `obsidian commands` 列出)。',
      },
    ],
  },
  {
    name: 'commands',
    family: 'command',
    danger: 'read',
    description: '列出所有可用的 Obsidian 命令 id(可按前缀过滤)。',
    params: [
      {
        name: 'filter',
        required: false,
        description: '按 id 前缀过滤(可选)。',
      },
    ],
  },
  {
    name: 'open',
    family: 'command',
    danger: 'write',
    description:
      '在 Obsidian 应用中打开指定笔记(打开行为是 UI 副作用,不等同于只读)。',
    params: [
      { name: 'path', required: true, description: 'vault 内相对路径。' },
    ],
  },

  // ── vault 族(vault 元信息) ──────────────────────────────────────
  {
    name: 'vault',
    family: 'vault',
    danger: 'read',
    description: '查看当前 vault 的元信息(路径、插件数、笔记数等)。',
    params: [],
  },
  {
    name: 'vaults',
    family: 'vault',
    danger: 'read',
    description: '列出已注册的 vault(便于切换)。',
    params: [],
  },
  {
    name: 'folders',
    family: 'vault',
    danger: 'read',
    description: '列出 vault 内的文件夹。',
    params: [
      { name: 'folder', required: false, description: '限定子文件夹(可选)。' },
    ],
  },
  {
    name: 'reload',
    family: 'vault',
    danger: 'write',
    description:
      '重载 vault(强制 Obsidian 重新扫描文件;用于外部工具写入后同步)。',
    params: [],
  },
];

/** 按 name 查 command(线性扫描;规模 N=30 量级,O(N) 够用)。 */
export function findCommand(name: string): ObsidianCommandSpec | undefined {
  return OBSIDIAN_COMMANDS.find((c) => c.name === name);
}

/** 按 family 收集 command。 */
export function commandsByFamily(
  family: ObsidianCommandSpec['family'],
): readonly ObsidianCommandSpec[] {
  return OBSIDIAN_COMMANDS.filter((c) => c.family === family);
}
