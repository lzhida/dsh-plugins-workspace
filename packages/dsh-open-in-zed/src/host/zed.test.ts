import { describe, expect, it } from 'vitest';
import {
  classifySpawnError,
  DEFAULT_ZED_BIN,
  isPlausibleDirectoryPath,
  LAUNCH_TIMEOUT_MS,
  openInZed,
  probeZed,
  resolveZedBin,
  ZED_BIN_ENV,
  zedOpenArgs,
  ZED_ERROR_CODES,
  ZedError,
  type SpawnOk,
} from './zed.ts';

describe('dsh-open-in-zed host/zed', () => {
  describe('isPlausibleDirectoryPath', () => {
    it('接受 Windows 盘符与 UNC 绝对路径', () => {
      expect(isPlausibleDirectoryPath('C:\\work\\repo')).toBe(true);
      expect(isPlausibleDirectoryPath('c:/work/repo')).toBe(true);
      expect(isPlausibleDirectoryPath('\\\\server\\share\\dir')).toBe(true);
      expect(isPlausibleDirectoryPath('E:\\')).toBe(true);
    });

    it('接受 POSIX 绝对路径', () => {
      expect(isPlausibleDirectoryPath('/home/user/repo')).toBe(true);
    });

    it('拒绝相对路径、空串、纯盘符、首尾空白与控制字符', () => {
      expect(isPlausibleDirectoryPath('relative/path')).toBe(false);
      expect(isPlausibleDirectoryPath('')).toBe(false);
      expect(isPlausibleDirectoryPath('   ')).toBe(false);
      expect(isPlausibleDirectoryPath(' C:\\work')).toBe(false);
      expect(isPlausibleDirectoryPath('C:')).toBe(false);
      expect(isPlausibleDirectoryPath('C:\\wor\nk')).toBe(false);
      expect(isPlausibleDirectoryPath('C:\0')).toBe(false);
      expect(isPlausibleDirectoryPath('-flag')).toBe(false);
    });
  });

  describe('zedOpenArgs', () => {
    it('默认只带目标路径', () => {
      expect(zedOpenArgs('C:\\work\\repo')).toEqual(['C:\\work\\repo']);
    });

    it('newWindow 时前置 --new', () => {
      expect(zedOpenArgs('C:\\work\\repo', { newWindow: true })).toEqual([
        '--new',
        'C:\\work\\repo',
      ]);
    });

    it('非法目标抛 invalid-target 的 ZedError', () => {
      expect(() => zedOpenArgs('nope')).toThrowError(ZedError);
      try {
        zedOpenArgs('nope');
      } catch (error) {
        expect((error as ZedError).code).toBe(ZED_ERROR_CODES.invalidTarget);
      }
    });
  });

  describe('resolveZedBin', () => {
    it('优先显式选项，其次环境变量，最后默认值', () => {
      expect(resolveZedBin({ bin: 'C:\\zed\\zed.exe' }, {})).toBe(
        'C:\\zed\\zed.exe',
      );
      expect(resolveZedBin(undefined, { [ZED_BIN_ENV]: 'zed-dev' })).toBe(
        'zed-dev',
      );
      expect(resolveZedBin(undefined, {})).toBe(DEFAULT_ZED_BIN);
      expect(resolveZedBin({ bin: '  ' }, { [ZED_BIN_ENV]: 'zed-dev' })).toBe(
        'zed-dev',
      );
    });
  });

  describe('classifySpawnError', () => {
    it('ENOENT 归类 notFound 且消息带安装指引与环境变量名', () => {
      const error = classifySpawnError('zed', { code: 'ENOENT' });
      expect(error.code).toBe(ZED_ERROR_CODES.notFound);
      expect(error.message).toContain('zed');
      expect(error.message).toContain(ZED_BIN_ENV);
    });

    it('ETIMEDOUT 与 killed 归类 timeout', () => {
      expect(classifySpawnError('zed', { code: 'ETIMEDOUT' }).code).toBe(
        ZED_ERROR_CODES.timeout,
      );
      expect(classifySpawnError('zed', { killed: true }).code).toBe(
        ZED_ERROR_CODES.timeout,
      );
    });

    it('非零退出归类 spawnFailed 并摘要 stderr（截断 300）', () => {
      const long = 'x'.repeat(500);
      const error = classifySpawnError('zed', {
        code: 1,
        stderr: `boom ${long}`,
      });
      expect(error.code).toBe(ZED_ERROR_CODES.spawnFailed);
      expect(error.message).toContain('boom');
      expect(error.message.length).toBeLessThanOrEqual(320);
    });

    it('非对象错误也能归类', () => {
      expect(classifySpawnError('zed', 'oops').code).toBe(
        ZED_ERROR_CODES.spawnFailed,
      );
    });
  });

  describe('openInZed', () => {
    it('以解析后的 bin 和 argv 调 runner，并回传 launch 记录', async () => {
      const calls: Array<{
        file: string;
        args: readonly string[];
        options: { timeout: number; windowsHide: boolean };
      }> = [];
      const runner = async (
        file: string,
        args: readonly string[],
        options: { timeout: number; windowsHide: boolean },
      ): Promise<SpawnOk> => {
        calls.push({ file, args, options });
        return { stdout: '', stderr: '' };
      };
      const launch = await openInZed(
        'C:\\work\\repo',
        { newWindow: true, bin: 'zed.exe', timeoutMs: 1234 },
        runner,
        {},
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        file: 'zed.exe',
        args: ['--new', 'C:\\work\\repo'],
        options: { timeout: 1234, windowsHide: true },
      });
      expect(launch).toEqual({
        path: 'C:\\work\\repo',
        command: ['zed.exe', '--new', 'C:\\work\\repo'],
      });
    });

    it('默认超时来自 LAUNCH_TIMEOUT_MS，bin 来自 env', async () => {
      let seen: { file: string; timeout: number } | undefined;
      const runner = async (
        file: string,
        _args: readonly string[],
        options: { timeout: number; windowsHide: boolean },
      ): Promise<SpawnOk> => {
        seen = { file, timeout: options.timeout };
        return { stdout: '', stderr: '' };
      };
      await openInZed('/tmp/repo', undefined, runner, {
        [ZED_BIN_ENV]: '/opt/zed/bin/zed',
      });
      expect(seen).toEqual({
        file: '/opt/zed/bin/zed',
        timeout: LAUNCH_TIMEOUT_MS,
      });
    });

    it('runner 抛 ENOENT 时转为 ZedError(notFound)', async () => {
      const runner = async (): Promise<SpawnOk> => {
        throw Object.assign(new Error('spawn zed ENOENT'), { code: 'ENOENT' });
      };
      await expect(
        openInZed('C:\\w', undefined, runner, {}),
      ).rejects.toMatchObject({ code: ZED_ERROR_CODES.notFound });
    });
  });

  describe('probeZed', () => {
    it('成功时回传版本首行', async () => {
      const runner = async (
        file: string,
        args: readonly string[],
      ): Promise<SpawnOk> => {
        expect(file).toBe('zed');
        expect(args).toEqual(['--version']);
        return { stdout: 'Zed 0.170.0\n', stderr: '' };
      };
      const status = await probeZed(runner, undefined, {});
      expect(status).toEqual({
        available: true,
        bin: 'zed',
        version: 'Zed 0.170.0',
      });
    });

    it('失败时 fail-soft 为 available:false', async () => {
      const runner = async (): Promise<SpawnOk> => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };
      const status = await probeZed(runner, undefined, {});
      expect(status).toEqual({ available: false, bin: 'zed' });
    });
  });
});
