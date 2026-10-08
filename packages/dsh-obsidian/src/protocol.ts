/**
 * dsh-obsidian system-prompt section:给 agent 的协议约束 + 命令清单。
 *
 * 设计要点:
 * - 文本不含 `{{var}}` 占位符(dsh 0.2.0-rc.2 的 renderPrompt 严格校验,
 *   见 dsh-taskboard 经验);
 * - section 名 `tool:obsidian`(唯一,dsh rc.2 同名重复注册会抛);
 * - order=2960(与 taskboard 的 2950 同档,落在 TOOL_TOOL=2900 与
 *   MCP_SERVERS=3100 之间;按 name 排序兜底,本名排在 taskboard 之后);
 * - 渲染纯文本 + 命令表 + 安全约束(危险等级 / vault 选择 / 协议错误
 *   前缀 "Error:" 的语义);命令表由 commands.ts 自动生成,避免双写漂移。
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

import { OBSIDIAN_COMMANDS, commandsByFamily } from './commands.ts';
import type { ObsidianCommandFamily, ObsidianDangerLevel } from './types.ts';

/** section 名(全局唯一,dsh 0.2.0-rc.2 重复注册会抛,故用包名空间)。 */
export const PROTOCOL_SECTION_NAME = 'tool:obsidian';

/** section order:PLUGIN 类,排在 taskboard(2950)之后。 */
export const PROTOCOL_SECTION_ORDER = 2960;

/** 各 family 在 prompt 中的展示顺序(便于 model 扫读)。 */
const FAMILY_ORDER: readonly ObsidianCommandFamily[] = [
  'file',
  'daily',
  'search',
  'property',
  'plugin-snippet',
  'command',
  'vault',
];

const FAMILY_TITLE: Readonly<Record<ObsidianCommandFamily, string>> = {
  file: '笔记 (file)',
  daily: '日常笔记 (daily)',
  search: '搜索 (search)',
  property: '属性 (property)',
  'plugin-snippet': '插件/CSS 片段 (plugin-snippet)',
  command: '命令面板 (command)',
  vault: 'Vault (vault)',
};

const DANGER_TAG: Readonly<Record<ObsidianDangerLevel, string>> = {
  read: '只读',
  write: '写入',
  destructive: '破坏',
  execute: '执行(权限闸)',
};

/** 渲染命令表的一行(供 prompt section 文本拼装)。 */
function renderCommandRow(c: {
  name: string;
  danger: ObsidianDangerLevel;
  description: string;
}): string {
  return `| \`${c.name}\` | ${DANGER_TAG[c.danger]} | ${c.description} |`;
}

/** 渲染单个 family 的命令小节。 */
function renderFamilySection(family: ObsidianCommandFamily): string {
  const cmds = commandsByFamily(family);
  if (cmds.length === 0) return '';
  const rows = cmds.map(renderCommandRow).join('\n');
  return `### ${FAMILY_TITLE[family]}\n\n| 命令 | 类型 | 说明 |\n| --- | --- | --- |\n${rows}`;
}

/** 整段 system-prompt section 文本。 */
const OBSIDIAN_PROTOCOL_TEXT = `You have a set of \`obsidian_*\` tools that wrap the native Obsidian CLI (\`obsidian <command> [key=value ...]\`). The CLI is shipped by the Obsidian app itself — if the tools return \`OBSIDIAN_CLI_NOT_FOUND\`, tell the user to install Obsidian and ensure \`obsidian\` is on PATH.

## Workflow

1. **Pick the right tool** — each \`obsidian_*\` tool maps to a single CLI sub-command. Use the tool inventory below as the source of truth; do not invent variants.
2. **Pass parameters as schema fields** — boolean flags (e.g. \`overwrite\`, \`permanent\`) are schema booleans; the tool will render them as \`name=true\` on the CLI.
3. **Choose a vault** — pass \`vault\` if the user has multiple vaults; omit it to use the active one.
4. **Read the result carefully** — Obsidian reports semantic errors as stdout lines starting with \`Error:\` (exit code 0). The tool surfaces those as \`OBSIDIAN_PROTOCOL_ERROR\`; the message is in \`stdout\`.
5. **Output is plain text** — \`obsidian read\` returns the note body, \`obsidian search\` returns matched lines, \`obsidian files\` returns one path per line. Render results faithfully; do not invent structure.

## Code-level protocol gates

- \`OBSIDIAN_CLI_NOT_FOUND\` — \`obsidian\` binary not on PATH. Stop and ask the user to install Obsidian / expose the CLI.
- \`OBSIDIAN_INVALID_INPUT\` — a required parameter is missing. The error names the parameter; supply it.
- \`OBSIDIAN_TIMEOUT\` — call exceeded the tool's \`timeoutMs\` (default 30s, cap 600s). Retry with a longer timeout or narrow the request.
- \`OBSIDIAN_PROTOCOL_ERROR\` — Obsidian returned an \`Error:\` line. Read \`stdout\`; do not retry blindly.
- \`OBSIDIAN_NONZERO_EXIT\` — Obsidian exited with a non-zero status. Inspect \`stderr\`.

## Danger levels

- **read** — safe; you can call freely.
- **write** — modifies the vault (create / append / prepend / set property). Mention the change in your reply so the user knows.
- **destructive** — delete / plugin:disable / snippet:disable. Confirm with the user before calling, unless the user already gave an explicit go-ahead for this exact target.
- **execute** — \`obsidian command\` runs an arbitrary Obsidian command palette entry whose effect you cannot predict from this prompt. Always run inside a permission-gated context; never call as the first action.

## Tool inventory

The \`obsidian_*\` tools are wrappers around the CLI. One tool per CLI sub-command. Source of truth: the table below (also lives in \`commands.ts\` so the README and the prompt can never drift).

${FAMILY_ORDER.map(renderFamilySection).filter(Boolean).join('\n\n')}

Total commands exposed: ${OBSIDIAN_COMMANDS.length}.

## Common mistakes to avoid

- **Inventing a CLI flag** — Obsidian CLI only accepts the parameters listed in the table. If you need \`tag\`, \`color\`, etc., use the \`property:set\` tool on the front-matter, not a fabricated flag.
- **Treating stdout \`Error:\` as success** — the tool always surfaces it as \`OBSIDIAN_PROTOCOL_ERROR\`. If you see that error code, the call did not succeed.
- **Calling \`obsidian command\` without a permission check** — this is the \`execute\` danger level; the host sandbox or permission prompt is the only safety net.
- **Hard-deleting with \`delete\` \`permanent=true\`** — that skips the Obsidian trash. Always confirm intent first; prefer non-permanent delete unless the user said "permanently".
- **Writing huge content** — Obsidian CLI has no streaming mode. The tool caps stdout at 20k chars and stderr at 4k; if you need more, chunk your write and read back in pieces.
`;

/** 构造 PromptSection(供 ctx.systemPrompt.section() 注册)。 */
export function obsidianSection(): PromptSection {
  return {
    name: PROTOCOL_SECTION_NAME,
    order: PROTOCOL_SECTION_ORDER,
    text: OBSIDIAN_PROTOCOL_TEXT,
  };
}
