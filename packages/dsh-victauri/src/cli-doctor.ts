/**
 * `victauri doctor` 文本报告解析。
 *
 * 独立成文件的原因：解析逻辑需要独立单测（0.8.8 实测格式），
 * 且解析失败必须**回退原文**而不是吞错误——解析器只负责"能解析就给出结构化，
 * 不能解析就返回 null"，回退由调用方（tools/cli.ts）决定。
 *
 * 0.8.8 实测输出（仓根执行，全 FAIL）：
 * ```
 * Victauri Doctor — checking your setup...
 *
 *   [FAIL] No Cargo.toml found in current directory
 *          Run this command from your Tauri project root.
 *
 * Summary: 0/1 passed, 1 failed, 0 warnings
 * Setup needs attention. Fix the [FAIL] items above to get started.
 * ```
 *
 * 另一个 0.8.8 实测事实：**报告全文落在 stderr**（stdout 为空串），
 * 因此调用方需要按"先 stdout 再 stderr"的顺序尝试解析（见
 * `parseDoctorReportFromStreams`）。
 */

/** 单条检查项状态。 */
export type DoctorCheckStatus = 'PASS' | 'FAIL' | 'WARN';

/** 单条检查项（`[PASS]/[FAIL]/[WARN]` 行 + 其缩进续行）。 */
export interface DoctorCheck {
  /** 检查项状态。 */
  readonly status: DoctorCheckStatus;
  /** 检查项正文（去掉 `[STATUS]` 前缀）。 */
  readonly message: string;
  /** 缩进续行（补充说明）；无则 null。 */
  readonly detail: string | null;
}

/** 结构化的 doctor 报告。 */
export interface DoctorReport {
  /** `Summary:` 行原文；未识别到则 null。 */
  readonly summary: string | null;
  /** 通过数；未识别到则 null。 */
  readonly passed: number | null;
  /** 检查项总数；未识别到则 null。 */
  readonly total: number | null;
  /** 失败数；未识别到则 null。 */
  readonly failed: number | null;
  /** 警告数；未识别到则 null。 */
  readonly warnings: number | null;
  /** 检查项明细（按输出顺序）。 */
  readonly checks: DoctorCheck[];
}

/** 检查项行：`[PASS]/[FAIL]/[WARN] + 正文`（允许前导缩进）。 */
const CHECK_LINE = /^\s*\[(PASS|FAIL|WARN)\]\s*(.+?)\s*$/;

/** 汇总行里的 `n/m passed`。 */
const SUMMARY_PASSED = /passed/i;
/** 汇总行里的 `n failed`。 */
const SUMMARY_FAILED = /(\d+)\s+failed/i;
/** 汇总行里的 `n warnings`。 */
const SUMMARY_WARNINGS = /(\d+)\s+warnings?/i;
/** 汇总行里的 `n/m`。 */
const SUMMARY_RATIO = /(\d+)\s*\/\s*(\d+)/;

/** 行首缩进宽度（制表符按 4 空格折算）。 */
function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * 解析 doctor 文本报告。
 *
 * 识别规则：
 * - `[PASS]/[FAIL]/[WARN] 正文` 行 → 一条检查项；
 * - 比检查项行缩进更深的后续非空行 → 该检查项的 detail（多行合并）；
 * - `Summary: n/m passed, k failed, w warnings` 行 → 计数（各段独立匹配，
 *   缺哪段哪段为 null）。
 *
 * @param stdout - doctor 子命令的 stdout 全文。
 * @returns 结构化报告；**既没有检查项也没有汇总行**时返回 null
 *          （调用方据此回退原文输出）。
 */
export function parseDoctorReport(stdout: string): DoctorReport | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;

  const lines = stdout.split(/\r?\n/);
  const checks: DoctorCheck[] = [];
  let summaryLine: string | null = null;

  let current: {
    check: DoctorCheck;
    detailLines: string[];
    indent: number;
  } | null = null;

  for (const line of lines) {
    const match = CHECK_LINE.exec(line);
    if (match !== null) {
      if (current !== null) {
        checks.push({
          ...current.check,
          detail:
            current.detailLines.length > 0
              ? current.detailLines.join('\n')
              : null,
        });
      }
      current = {
        check: {
          status: match[1] as DoctorCheckStatus,
          message: match[2],
          detail: null,
        },
        detailLines: [],
        indent: indentOf(line),
      };
      continue;
    }

    if (current !== null) {
      const trimmed = line.trim();
      if (trimmed !== '' && indentOf(line) > current.indent) {
        current.detailLines.push(trimmed);
        continue;
      }
      // 非缩进续行：结束当前检查项，再看是不是汇总行
      if (trimmed !== '' && /summary\s*:/i.test(trimmed)) {
        summaryLine = trimmed;
      }
      checks.push({
        ...current.check,
        detail:
          current.detailLines.length > 0
            ? current.detailLines.join('\n')
            : null,
      });
      current = null;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed !== '' && /summary\s*:/i.test(trimmed)) {
      summaryLine = trimmed;
    }
  }

  if (current !== null) {
    checks.push({
      ...current.check,
      detail:
        current.detailLines.length > 0 ? current.detailLines.join('\n') : null,
    });
  }

  if (checks.length === 0 && summaryLine === null) return null;

  let passed: number | null = null;
  let total: number | null = null;
  let failed: number | null = null;
  let warnings: number | null = null;

  if (summaryLine !== null) {
    if (SUMMARY_PASSED.test(summaryLine)) {
      const ratio = SUMMARY_RATIO.exec(summaryLine);
      if (ratio !== null) {
        passed = Number(ratio[1]);
        total = Number(ratio[2]);
      }
    }
    const failedMatch = SUMMARY_FAILED.exec(summaryLine);
    if (failedMatch !== null) failed = Number(failedMatch[1]);
    const warningsMatch = SUMMARY_WARNINGS.exec(summaryLine);
    if (warningsMatch !== null) warnings = Number(warningsMatch[1]);
  }

  return { summary: summaryLine, passed, total, failed, warnings, checks };
}

/**
 * 从一次 CLI 执行的 stdout/stderr 中提取 doctor 结构化报告。
 *
 * 顺序：先 stdout，再 stderr——0.8.8 实测报告写在 stderr（stdout 为空），
 * 而 0.10 起的文档口径是 stdout 输出报告。两路都识别不到报告时返回 null，
 * 调用方据此回退原文（stdout/stderr 原文始终原样保留在工具输出里）。
 *
 * @param stdout - CLI 执行的 stdout 全文。
 * @param stderr - CLI 执行的 stderr 全文。
 */
export function parseDoctorReportFromStreams(
  stdout: string,
  stderr: string,
): DoctorReport | null {
  return parseDoctorReport(stdout) ?? parseDoctorReport(stderr);
}
