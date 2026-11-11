import { describe, expect, it } from 'vitest';

import {
  parseDoctorReport,
  parseDoctorReportFromStreams,
} from './cli-doctor.ts';

/** 0.8.8 实测输出(仓根执行,全 FAIL)。 */
const SAMPLE_088 = `Victauri Doctor — checking your setup...

  [FAIL] No Cargo.toml found in current directory
         Run this command from your Tauri project root.

Summary: 0/1 passed, 1 failed, 0 warnings
Setup needs attention. Fix the [FAIL] items above to get started.
`;

describe('dsh-victauri doctor 报告解析', () => {
  it('0.8.8 实测格式:解析出 FAIL 明细 + Summary 计数', () => {
    const report = parseDoctorReport(SAMPLE_088);
    expect(report).not.toBeNull();
    expect(report?.checks).toEqual([
      {
        status: 'FAIL',
        message: 'No Cargo.toml found in current directory',
        detail: 'Run this command from your Tauri project root.',
      },
    ]);
    expect(report?.passed).toBe(0);
    expect(report?.total).toBe(1);
    expect(report?.failed).toBe(1);
    expect(report?.warnings).toBe(0);
    expect(report?.summary).toBe('Summary: 0/1 passed, 1 failed, 0 warnings');
  });

  it('PASS/FAIL/WARN 混合明细按输出顺序解析', () => {
    const report = parseDoctorReport(`Victauri Doctor

  [PASS] CLI installed (0.8.8)
  [WARN] cargo not on PATH
         install rustup to fix
  [FAIL] No Cargo.toml found in current directory
         Run this command from your Tauri project root.

Summary: 1/3 passed, 1 failed, 1 warnings
`);
    expect(report?.checks.map((check) => check.status)).toEqual([
      'PASS',
      'WARN',
      'FAIL',
    ]);
    expect(report?.checks[1]?.detail).toBe('install rustup to fix');
    expect(report?.checks[0]?.detail).toBeNull();
    expect(report?.passed).toBe(1);
    expect(report?.total).toBe(3);
    expect(report?.failed).toBe(1);
    expect(report?.warnings).toBe(1);
  });

  it('仅有 Summary 行也能解析(无明细时 checks 为空数组)', () => {
    const report = parseDoctorReport('Summary: 2/2 passed\n');
    expect(report?.checks).toEqual([]);
    expect(report?.passed).toBe(2);
    expect(report?.total).toBe(2);
    expect(report?.failed).toBeNull();
    expect(report?.warnings).toBeNull();
  });

  it('多行缩进续行合并为 detail', () => {
    const report = parseDoctorReport(`  [FAIL] something wrong
         first detail line
         second detail line
`);
    expect(report?.checks[0]?.detail).toBe(
      'first detail line\nsecond detail line',
    );
  });

  it('无法解析时返回 null(调用方据此回退原文)', () => {
    expect(
      parseDoctorReport(
        "error: unexpected argument '--json' found\n\nUsage: victauri doctor\n",
      ),
    ).toBeNull();
    expect(parseDoctorReport('')).toBeNull();
    expect(parseDoctorReport('   \n  \n')).toBeNull();
    expect(parseDoctorReport('nothing interesting here')).toBeNull();
  });
});

describe('dsh-victauri doctor 双路解析(stdout 优先,再 stderr)', () => {
  it('0.8.8 实测:报告在 stderr、stdout 为空 → 仍能解析出明细', () => {
    const report = parseDoctorReportFromStreams('', SAMPLE_088);
    expect(report).not.toBeNull();
    expect(report?.checks[0]?.status).toBe('FAIL');
    expect(report?.failed).toBe(1);
  });

  it('stdout 有报告时优先用 stdout', () => {
    const report = parseDoctorReportFromStreams(
      'Summary: 3/3 passed\n',
      SAMPLE_088,
    );
    expect(report?.passed).toBe(3);
    expect(report?.total).toBe(3);
    expect(report?.failed).toBeNull();
  });

  it('两路都识别不到报告时返回 null(回退原文)', () => {
    expect(
      parseDoctorReportFromStreams(
        '',
        "error: unexpected argument '--json' found\n\nUsage: victauri doctor\n",
      ),
    ).toBeNull();
    expect(parseDoctorReportFromStreams('', '')).toBeNull();
  });
});
