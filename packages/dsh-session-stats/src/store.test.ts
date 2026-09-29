import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { syncSessions } from './store.ts';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stats-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeSessionFile(
  home: string,
  project: string,
  sessionId: string,
  content: string,
): string {
  const dir = path.join(
    home,
    'sessions',
    `--${project}--`,
    `session-${sessionId}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const frame = zlib.zstdCompressSync(Buffer.from(content, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, frame);
  return file;
}

function sessionJson(sessionId: string, cwd: string): string {
  return JSON.stringify({
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd,
  });
}

describe('dsh-session-stats 增量同步', () => {
  it('发现、解码并持久化会话；二次同步零重解码', () => {
    const home = makeTempHome();
    writeSessionFile(
      home,
      'proj-a',
      's1',
      `${sessionJson('session-s1', 'E:\\proj-a')}\n`,
    );
    const { result } = syncSessions({ dshHome: home });
    expect(result.files).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.sessions).toBe(1);
    expect(result.totalMessages).toBe(0);

    // 未变化的文件不重解码
    const second = syncSessions({ dshHome: home });
    expect(second.result.processed).toBe(0);
    expect(second.result.sessions).toBe(1);

    // store 落盘且可读
    const storePath = path.join(home, 'dsh-session-stats', 'store.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(store.sessions)).toHaveLength(1);
  });

  it('文件变化后重解码，文件删除后从 store 移除', async () => {
    const home = makeTempHome();
    const file = writeSessionFile(
      home,
      'proj-a',
      's1',
      `${sessionJson('session-s1', 'E:\\proj-a')}\n`,
    );
    syncSessions({ dshHome: home });

    // 追加一个事件帧 → mtime/size 变化
    const extra = zlib.zstdCompressSync(
      Buffer.from(
        `${JSON.stringify({ type: 'user/message', time: 1_700_000_010_000, data: {} })}\n`,
        'utf8',
      ),
    );
    fs.appendFileSync(file, extra);
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(file, future, future);
    const changed = syncSessions({ dshHome: home });
    expect(changed.result.processed).toBe(1);
    expect(changed.result.totalMessages).toBe(1);

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    const removed = syncSessions({ dshHome: home });
    expect(removed.result.files).toBe(0);
    expect(removed.result.sessions).toBe(0);
  });
});
