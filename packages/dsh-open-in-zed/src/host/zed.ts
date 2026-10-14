/**
 * Zed launcher face: the ONLY place dsh-open-in-zed shells out to the zed
 * CLI. Pure argument construction, an injectable exec layer, and a narrow
 * error taxonomy the route layer maps onto HTTP responses.
 *
 * Design invariants:
 * - PURE construction: `zedOpenArgs` never touches the process — unit tests
 *   assert exact argument vectors without spawning anything.
 * - INJECTABLE runner: the exec layer is one function so tests script every
 *   path (ENOENT, timeout, non-zero exit) without a real zed.
 * - FAIL-LOUD with READABLE errors: unlike internal git probing, a failed
 *   launch IS the user-visible outcome, so every failure carries an action-
 *   able message (install hint for a missing binary, stderr digest otherwise).
 * - NO shell: `execFile` bypasses cmd.exe — no quoting/interp surface at all.
 *
 * @module dsh-open-in-zed/host/zed
 */
import { isAbsolute } from 'node:path';

/** Error codes surfaced to the GUI / agent tool (stable contract). */
export const ZED_ERROR_CODES = {
  /** Target is not a usable directory path (empty, control chars, relative). */
  invalidTarget: 'invalid-target',
  /** The zed executable is not on PATH (and no explicit bin was configured). */
  notFound: 'zed-not-found',
  /** The zed CLI exceeded its launch timeout. */
  timeout: 'zed-timeout',
  /** zed exited non-zero (or the spawn failed for another OS reason). */
  spawnFailed: 'zed-spawn-failed',
} as const;

/** One {@link ZED_ERROR_CODES} member. */
export type ZedErrorCode =
  (typeof ZED_ERROR_CODES)[keyof typeof ZED_ERROR_CODES];

/** Launcher failure carrying a stable code the route layer maps to HTTP. */
export class ZedError extends Error {
  readonly code: ZedErrorCode;

  constructor(code: ZedErrorCode, message: string) {
    super(message);
    this.name = 'ZedError';
    this.code = code;
  }
}

/** Environment variable overriding the zed executable (absolute path or PATH name). */
export const ZED_BIN_ENV = 'DSH_OPEN_IN_ZED_BIN';

/** Default executable name resolved through PATH. */
export const DEFAULT_ZED_BIN = 'zed';

/** Launch timeout: the CLI returns as soon as it hands the path to the app. */
export const LAUNCH_TIMEOUT_MS = 10_000;

/** Probe timeout for `zed --version`. */
export const PROBE_TIMEOUT_MS = 3_000;

/** Hard cap on a target path (guards against absurd payloads, not a security boundary). */
const MAX_TARGET_LENGTH = 1024;

/** Open options. */
export interface ZedOpenOptions {
  /** Explicit executable override; falls back to {@link ZED_BIN_ENV}, then {@link DEFAULT_ZED_BIN}. */
  bin?: string;
  /** Ask zed for a fresh window instead of reusing the workspace's last one. */
  newWindow?: boolean;
  /** Spawn timeout in ms; default {@link LAUNCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A successful launch. */
export interface ZedLaunch {
  /** The directory handed to zed. */
  path: string;
  /** The exact argv that was executed (for UI display and tests). */
  command: readonly string[];
}

/** Exec result shape both the real runner and tests produce. */
export interface SpawnOk {
  stdout: string;
  stderr: string;
}

/**
 * The exec layer: `execFile(file, args, options)` resolving stdout/stderr.
 * Injected so unit tests never spawn a real process.
 */
export type SpawnRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<SpawnOk>;

/**
 * Whether `candidate` is a plausible absolute directory path on either path
 * grammar (Windows drive/UNC or POSIX). This is a shape check only — the
 * route layer separately requires the path to be a registered workspace.
 * @param candidate - Raw path string.
 * @returns true when the shape is absolute and free of control characters.
 */
export function isPlausibleDirectoryPath(candidate: string): boolean {
  if (typeof candidate !== 'string') return false;
  const trimmed = candidate.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_TARGET_LENGTH ||
    trimmed !== candidate
  ) {
    return false;
  }
  // Control characters and line breaks never belong in a directory path and
  // would corrupt logs and CLI argv even without a shell.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  const windows = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  const posix = trimmed.startsWith('/');
  if (!windows && !posix) return false;
  // A Windows path must be absolute in node's view of the current platform
  // grammar too: `isAbsolute` with win32 semantics accepts `C:\x` everywhere.
  return isAbsolute(trimmed) || windows;
}

/**
 * Resolve the effective zed executable: explicit option → env override →
 * the default PATH name.
 * @param options - Open options (optional bin).
 * @param env - Environment map (defaults to `process.env`).
 * @returns the executable to spawn.
 */
export function resolveZedBin(
  options?: Pick<ZedOpenOptions, 'bin'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromOption = options?.bin?.trim();
  if (fromOption !== undefined && fromOption.length > 0) return fromOption;
  const fromEnv = env[ZED_BIN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return DEFAULT_ZED_BIN;
}

/**
 * Build the exact argv for opening `path` in zed.
 * @param path - Absolute directory path (validated).
 * @param options - Open options (`newWindow` prepends `--new`).
 * @returns the argument vector, target last.
 * @throws ZedError `invalid-target` when the path is unusable.
 */
export function zedOpenArgs(
  path: string,
  options?: Pick<ZedOpenOptions, 'newWindow'>,
): string[] {
  if (!isPlausibleDirectoryPath(path)) {
    throw new ZedError(
      ZED_ERROR_CODES.invalidTarget,
      `不是可打开的绝对目录路径: ${JSON.stringify(path.slice(0, 64))}`,
    );
  }
  const args: string[] = [];
  if (options?.newWindow === true) args.push('--new');
  args.push(path);
  return args;
}

/**
 * The real exec layer over `node:child_process.execFile` (promisified).
 * @returns a runner with the documented timeout/windowsHide contract.
 */
export function defaultSpawnRunner(): SpawnRunner {
  return async (file, args, options) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    return run(file, [...args], {
      timeout: options.timeout,
      windowsHide: options.windowsHide,
    }) as Promise<SpawnOk>;
  };
}

/**
 * Map a spawn failure to a `ZedError` with an actionable message.
 * @param file - The executable that failed.
 * @param error - The thrown value from the runner.
 * @returns the classified error.
 */
export function classifySpawnError(file: string, error: unknown): ZedError {
  const code =
    typeof error === 'object' && error !== null
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  const killed =
    typeof error === 'object' &&
    error !== null &&
    (error as { killed?: boolean }).killed === true;
  if (code === 'ENOENT') {
    return new ZedError(
      ZED_ERROR_CODES.notFound,
      `未找到 Zed 可执行文件 "${file}"。请安装 Zed 并确认 "zed" 在 PATH 中` +
        `（或用环境变量 ${ZED_BIN_ENV} 指定完整路径）。`,
    );
  }
  if (code === 'ETIMEDOUT' || killed === true) {
    return new ZedError(
      ZED_ERROR_CODES.timeout,
      `启动 Zed 超时：命令 "${file}" 在超时窗口内未返回。`,
    );
  }
  const stderr =
    typeof error === 'object' && error !== null
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : '';
  const message =
    typeof error === 'object' && error !== null
      ? String((error as Error).message ?? error)
      : String(error);
  const digest = (stderr.length > 0 ? stderr : message)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return new ZedError(
    ZED_ERROR_CODES.spawnFailed,
    digest.length > 0
      ? `Zed 启动失败: ${digest}`
      : `Zed 启动失败（未知原因，命令 "${file}"）。`,
  );
}

/**
 * Probe whether the zed CLI is callable (`zed --version`), fail-soft: any
 * failure resolves to `available: false` instead of throwing — the status
 * endpoint is advisory UI state, not an action.
 * @param runner - Injected exec layer.
 * @param options - Optional explicit bin override.
 * @param env - Environment map (defaults to `process.env`).
 * @returns availability, the resolved bin, and the version line when present.
 */
export async function probeZed(
  runner: SpawnRunner,
  options?: Pick<ZedOpenOptions, 'bin'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ available: boolean; bin: string; version?: string }> {
  const bin = resolveZedBin(options, env);
  try {
    const result = await runner(bin, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const version = result.stdout.split(/\r?\n/, 1)[0]?.trim();
    return {
      available: true,
      bin,
      ...(version !== undefined && version.length > 0 ? { version } : {}),
    };
  } catch {
    return { available: false, bin };
  }
}

/**
 * Launch zed on a directory.
 * @param path - Validated absolute directory path.
 * @param options - bin override / newWindow / timeout.
 * @param runner - Injected exec layer (defaults to {@link defaultSpawnRunner}).
 * @param env - Environment map (defaults to `process.env`).
 * @returns the launch record on success.
 * @throws ZedError with a stable {@link ZedErrorCode} on every failure shape.
 */
export async function openInZed(
  path: string,
  options?: ZedOpenOptions,
  runner: SpawnRunner = defaultSpawnRunner(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ZedLaunch> {
  const bin = resolveZedBin(options, env);
  const args = zedOpenArgs(path, options);
  try {
    await runner(bin, args, {
      timeout: options?.timeoutMs ?? LAUNCH_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    throw classifySpawnError(bin, error);
  }
  return { path, command: [bin, ...args] };
}
