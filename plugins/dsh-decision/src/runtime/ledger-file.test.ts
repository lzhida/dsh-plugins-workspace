import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryLedger, type LedgerEntry } from './ledger.ts';
import { createFileLedger, resolveLedgerPath } from './ledger-file.ts';

describe('dsh-decision 文件账本', () => {
  const dirs: string[] = [];
  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-decision-ledger-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const mkEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
    decisionId: 'dec_0123456789ABCDEFGHJKMNPQRS',
    ts: '2026-03-15T09:00:00.000Z',
    tool: 'decision_decide',
    mode: 'primary',
    source: 'decision-model',
    questionId: 'q1',
    questionType: 'noul',
    questionSummary: null,
    status: 'ok',
    payload: { value: 0.9, confidence: 0.9, distribution: null, legend: null },
    outcome: { state: 'unknown', value: null, source: null, updatedAt: null },
    usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
    latencyMs: 20,
    costUsd: 0,
    costEstimated: false,
    ...overrides,
  });

  const makeLedger = (dir: string, maxEntries = 10) =>
    createFileLedger({
      resolvePath: () => join(dir, 'ledger.jsonl'),
      resolveMaxEntries: () => maxEntries,
    });

  it('resolveLedgerPath 优先 DSH_HOME，缺省回退 ~/.dsh', () => {
    expect(resolveLedgerPath({ dshHome: 'X:/dsh-home' })).toBe(
      join('X:/dsh-home', 'plugins', 'dsh-decision', 'ledger.jsonl'),
    );
    expect(resolveLedgerPath({ home: 'Y:/home' })).toBe(
      join('Y:/home', '.dsh', 'plugins', 'dsh-decision', 'ledger.jsonl'),
    );
    expect(resolveLedgerPath({ dshHome: '  ' })).toBe(
      join('', '.dsh', 'plugins', 'dsh-decision', 'ledger.jsonl'),
    );
  });

  it('append 持久化到磁盘且 list 为最新在前', () => {
    const dir = makeTempDir();
    const ledger = makeLedger(dir);
    ledger.append(mkEntry({ decisionId: 'dec_0123456789ABCDEFGHJKMNPQRS' }));
    ledger.append(mkEntry({ decisionId: 'dec_ZZZ3456789ABCDEFGHJKMNPQRS' }));
    const raw = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    expect(raw.split('\n').filter((line) => line.trim() !== '')).toHaveLength(
      2,
    );
    expect(ledger.list().map((entry) => entry.decisionId)).toEqual([
      'dec_ZZZ3456789ABCDEFGHJKMNPQRS',
      'dec_0123456789ABCDEFGHJKMNPQRS',
    ]);
  });

  it('重启后从磁盘恢复既有条目', () => {
    const dir = makeTempDir();
    makeLedger(dir).append(mkEntry());
    const reopened = makeLedger(dir);
    expect(reopened.size()).toBe(1);
    expect(reopened.findById('dec_0123456789ABCDEFGHJKMNPQRS')?.tool).toBe(
      'decision_decide',
    );
  });

  it('损坏行跳过并告警，不中断加载', () => {
    const dir = makeTempDir();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(
      join(dir, 'ledger.jsonl'),
      `${JSON.stringify(mkEntry())}\nnot-json-at-all\n{"lost":"entry"}\n`,
      'utf8',
    );
    const ledger = makeLedger(dir);
    expect(ledger.size()).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('corrupted line');
  });

  it('超过上限时整文件重写并淘汰最旧条目', () => {
    const dir = makeTempDir();
    const ledger = makeLedger(dir, 2);
    ledger.append(mkEntry({ decisionId: 'dec_AAA3456789ABCDEFGHJKMNPQRS' }));
    ledger.append(mkEntry({ decisionId: 'dec_BBB3456789ABCDEFGHJKMNPQRS' }));
    ledger.append(mkEntry({ decisionId: 'dec_CCC3456789ABCDEFGHJKMNPQRS' }));
    expect(ledger.size()).toBe(2);
    expect(ledger.findById('dec_AAA3456789ABCDEFGHJKMNPQRS')).toBeUndefined();
    const raw = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    expect(raw).not.toContain('dec_AAA');
    expect(raw).toContain('dec_BBB');
    expect(raw).toContain('dec_CCC');
  });

  it('updateOutcome 回填后同步落盘', () => {
    const dir = makeTempDir();
    const ledger = makeLedger(dir);
    ledger.append(mkEntry());
    const updated = ledger.updateOutcome('dec_0123456789ABCDEFGHJKMNPQRS', {
      state: 'confirmed',
      source: 'downstream',
    });
    expect(updated).toBe(true);
    const reopened = makeLedger(dir);
    expect(
      reopened.findById('dec_0123456789ABCDEFGHJKMNPQRS')?.outcome.state,
    ).toBe('confirmed');
    expect(
      reopened.findById('dec_0123456789ABCDEFGHJKMNPQRS')?.outcome.updatedAt,
    ).not.toBeNull();
  });

  it('内存账本与文件账本满足同一 LedgerSink 契约（可互换注入）', () => {
    const memory = createMemoryLedger(5);
    const dir = makeTempDir();
    const file = makeLedger(dir);
    for (const ledger of [memory, file]) {
      ledger.append(mkEntry());
      expect(ledger.size()).toBe(1);
      expect(ledger.list()).toHaveLength(1);
      expect(ledger.findById('missing')).toBeUndefined();
    }
  });
});
