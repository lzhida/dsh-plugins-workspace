/**
 * REST 桥工厂：catalog 规格 VictauriClient.callTool 透传 → dsh 工具。
 *
 * 通用行为：
 * - 别名归一：eval_js(expression→code)、query_db(sql→query)——0.8.8 实测参数名优先，
 *   文档命名兼容（两者都给时以实测名为准）；
 * - JSON 值透传：入参收敛为纯 JSON 值（isJsonValue 守卫）后**原样**发送，
 *   type:'json' 的参数（assert_semantic.expected / wait_for.expected /
 *   storage.value）数值、对象、数组、null 均不被字符串化；
 * - 图像通道：结果中的 {data,mimeType} 形态图像值（顶层对象或 REST 多块数组，
 *   覆盖 screenshot / trace frames / animation scrub filmstrip）在 renderJson
 *   截断之前统一落盘 %TEMP%\dsh-victauri\ 返回路径，落盘失败回退原文并保留错误；
 * - 数组结果包装为 {items: [...]}（dsh execute 契约要求顶层 object，find_elements 实测顶层数组）；
 * - 未知参数键照常透传（上游静默忽略），结果顶层附加 ignored_args 排序提示（M-4，
 *   known 集合 = schema 声明键 + 上游正式 serde 别名（window/window_label/label 等，
 *   见 UPSTREAM_WINDOW_ALIAS_TOOLS / UPSTREAM_EXTRA_ALIASES）；插件自有别名键
 *   （expression/sql）在归一时已从请求中移除，不会误报；图像通道与错误信封不附加；
 *   上游结果自带同名键时插件提示改用 ignored_args_plugin 备用键，不覆盖上游值）；
 * - 错误面：VictauriError 系列不 throw，返回结构化 {error:{kind,message,hint,status?}} +
 *   自检指引（启动 app / victauri check）；status 仅 HTTP 分流错误携带（M-1）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { VictauriClientLike } from '../../client.ts';
import {
  isVictauriError,
  VictauriError,
  VictauriHttpError,
} from '../../errors.ts';
import type { JsonValue } from '../../json.ts';
import { normalizeImageResult, saveImage } from './image.ts';
import type { RestToolSpec } from './catalog.ts';
import { toJsonArgs } from './json-value.ts';
import { resolveRequestBudgetMs } from './timeout.ts';
import { renderJson } from './render.ts';

/** 工具运行期依赖：惰性取连接（装配层缓存复用；连接异步建立）。 */
export interface BridgeDeps {
  getClient: () => Promise<VictauriClientLike>;
}

/** 无 app 运行/调用失败时的自检指引。 */
export const SELF_CHECK_HINT =
  '自检指引: ① 确认 Tauri app 已以 debug 构建启动且接入了 victauri-plugin(' +
  'Builder.plugin(victauri_plugin::init())); ② 运行 victauri check 检查项目配置; ' +
  '③ 首次使用可先跑本插件 demo-app(debug 构建)验证链路';

/** 把异常归一为结构化错误值（不向模型抛栈）。 */
function toErrorValue(err: unknown): Record<string, JsonValue> {
  const kind = isVictauriError(err) ? err.kind : 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  // M-1(backlog-A):HTTP 分流错误透出可选 status(非 HTTP 错误不带该键,向后兼容)
  const status = err instanceof VictauriHttpError ? err.status : undefined;
  return {
    error: {
      kind,
      message,
      hint: SELF_CHECK_HINT,
      ...(status !== undefined ? { status } : {}),
    },
  };
}

/** 需要别名归一的工具（实测名 ← 文档别名）。 */
const ARG_ALIASES: Readonly<
  Record<string, readonly [primary: string, alias: string]>
> = {
  eval_js: ['code', 'expression'],
  query_db: ['query', 'sql'],
};

/**
 * 图像通道：把 callTool 结果中的图像值落盘并替换为文件引用。
 * 返回 null = 结果不含图像（调用方走原 toRecord 通道，零行为变化）。
 * save 可注入用于测试落盘失败回退路径。
 */
export function applyImageChannel(
  result: JsonValue,
  toolName: string,
  save: typeof saveImage = saveImage,
): Record<string, JsonValue> | null {
  try {
    return normalizeImageResult(result, toolName, save);
  } catch (err) {
    // 落盘失败：回退原文返回并保留错误信息（不吞错）
    return {
      ...toRecord(result),
      image_save_error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 数组结果守卫（find_elements 实测顶层数组）。 */
function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** 把 callTool 结果归一为顶层 object(dsh execute 契约要求 Record)。 */
function toRecord(value: JsonValue): Record<string, JsonValue> {
  if (isArrayValue(value)) return { items: value };
  if (typeof value === 'object' && value !== null) return value;
  return { value };
}

/**
 * 上游 webview_label 字段带 serde alias window/window_label 的工具集合
 * （0.10.3 源码逐一核对：victauri-plugin-0.10.3/src/mcp/*_params.rs）。
 * 这些键会被上游真实消费，M-4 提示不得把它们报成 ignored：
 * standalone：assert_semantic / check_ipc_integrity / detect_ghost_commands /
 *   dom_snapshot / eval_js / find_elements / get_diagnostics / invoke_command /
 *   verify_state / wait_for；
 * compound：animation / css / explain / input / inspect / interact / introspect /
 *   logs / navigate / recording / route / storage / trace。
 * 不在集合内：app_state / fault（上游结构体没有 webview_label 字段，插件多声明的
 *   webview_label 会被上游静默忽略——见 risk 文档备忘）；纯后端工具
 *   （get_registry / list_app_dir / read_app_file / resolve_command / query_db /
 *   get_memory_stats / get_plugin_info）没有 webview 目标参数。
 */
export const UPSTREAM_WINDOW_ALIAS_TOOLS: ReadonlySet<string> = new Set([
  'assert_semantic',
  'check_ipc_integrity',
  'detect_ghost_commands',
  'dom_snapshot',
  'eval_js',
  'find_elements',
  'get_diagnostics',
  'invoke_command',
  'verify_state',
  'wait_for',
  'animation',
  'css',
  'explain',
  'input',
  'inspect',
  'interact',
  'introspect',
  'logs',
  'navigate',
  'recording',
  'route',
  'storage',
  'trace',
]);

/** window 组之外的上游正式 serde 别名（同样真实消费，不得误报）。 */
export const UPSTREAM_EXTRA_ALIASES: Readonly<
  Record<string, readonly string[]>
> = {
  // ScreenshotParams.window_label：alias window + webview_label（window_params.rs:6-9）
  screenshot: ['window', 'webview_label'],
  // WindowParams.label：alias webview_label/window/window_label（compound_params.rs:285-292）
  window: ['webview_label', 'window', 'window_label'],
  // RecordingParams.checkpoint_label：alias label（compound_params.rs:457-459）
  recording: ['label'],
};

/**
 * M-4(批十三 2/2):收集「schema 未声明且非上游正式别名」的参数键。
 * 上游对未知键静默忽略(0.8.8/0.10.2/0.10.3 均无 deny_unknown_fields,backlog-A 订正),
 * 本层不改变发送内容(透传语义不变),只把「传了但不生效」的键回报给模型;
 * 返回按字母排序保证确定性。图像通道与错误信封路径不附加该提示。
 * 注:插件自有别名键(expression/sql)在归一时已从请求中移除,天然不会出现在这里。
 */
function collectIgnoredArgs(
  callArgs: Record<string, JsonValue>,
  spec: RestToolSpec,
): string[] {
  // ParameterSchemaSpec 顶层即属性映射(implicit open object root)
  const known = new Set(Object.keys(spec.parameters));
  if (UPSTREAM_WINDOW_ALIAS_TOOLS.has(spec.name)) {
    known.add('window');
    known.add('window_label');
  }
  for (const key of UPSTREAM_EXTRA_ALIASES[spec.name] ?? []) known.add(key);
  return Object.keys(callArgs)
    .filter((key) => !known.has(key))
    .sort();
}

/**
 * 由规格构建单个 REST 桥工具。dsh 工具名 = `victauri_` + victauri 工具名。
 * 输出 schema 为开放对象（透传透出，形状由 victauri 端决定）。
 */
export function createRestBridgeTool(
  spec: RestToolSpec,
  deps: BridgeDeps,
): ToolDefinition {
  const alias = ARG_ALIASES[spec.name];
  return defineTool({
    name: `victauri_${spec.name}`,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJson,
    },
    execute: async (args, exec) => {
      void exec;
      try {
        // 入参收敛为纯 JSON 值（丢弃 undefined 与非 JSON 值）后**原样透传**：
        // 任意 JSON 值参数（expected / storage.value）不会被字符串化
        const callArgs: Record<string, JsonValue> = toJsonArgs(
          args as unknown as Record<string, unknown>,
        );
        // 别名归一:实测名优先,文档别名兜底;别名键移除仅为本插件防混淆——
        // 上游对未知键是静默忽略(0.8.8/0.10.2/0.10.3 全仓均无 deny_unknown_fields,
        // backlog-A 订正),不移除也能被服务端忽略,但会让「实际生效的键」难以观察
        if (alias) {
          const [primary, aliasKey] = alias;
          const aliasVal = callArgs[aliasKey];
          if (callArgs[primary] === undefined && aliasVal !== undefined) {
            callArgs[primary] = aliasVal;
          }
          if (aliasVal !== undefined) delete callArgs[aliasKey];
          // required 注解无法覆盖别名路径(defineTool 校验在归一前):兜底结构化报错
          if (callArgs[primary] === undefined) {
            return toErrorValue(
              new VictauriError(
                'tool-error',
                `missing required property "${primary}" (alias "${aliasKey}" accepted)`,
              ),
            );
          }
        }
        const client = await deps.getClient();
        // per-tool 请求预算:wait_for 动态 > spec 声明 > 无覆盖(客户端默认链)
        const budget = resolveRequestBudgetMs(
          spec.name,
          callArgs,
          spec.requestBudgetMs,
        );
        const result = await client.callTool(spec.name, callArgs, budget);
        // M-4(批十三 2/2):未知键透传不变,仅在结果顶层附加 ignored_args 提示
        const ignored = collectIgnoredArgs(callArgs, spec);
        // 图像通道:{data,mimeType} 形态统一落盘返回路径;无图像走原通道
        const imaged = applyImageChannel(result, spec.name);
        if (imaged !== null) return imaged;
        const record = toRecord(result);
        if (ignored.length === 0) return record;
        // 上游同名键防御:极少数上游结果自带 ignored_args 键时不覆盖上游值,
        // 插件提示改用 ignored_args_plugin 备用键(两键并存,V2 低-5)
        const hintKey =
          'ignored_args' in record ? 'ignored_args_plugin' : 'ignored_args';
        return { ...record, [hintKey]: ignored };
      } catch (err) {
        return toErrorValue(err);
      }
    },
  });
}

/** 构建 20 个 standalone 桥工具。 */
export function createStandaloneTools(
  specs: readonly RestToolSpec[],
  deps: BridgeDeps,
): ToolDefinition[] {
  return specs.map((spec) => createRestBridgeTool(spec, deps));
}
