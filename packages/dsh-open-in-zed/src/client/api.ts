/**
 * Browser → host API for dsh-open-in-zed: one POST to the plugin route.
 * Envelope parsing mirrors the dsh-taskboard client: every non-2xx or
 * non-JSON answer becomes a thrown Error with a readable message.
 *
 * @module dsh-open-in-zed/client/api
 */

/** Success envelope (host convention). */
export type ApiOk<T> = { ok: true; value: T };

/** Failure envelope. */
export type ApiFail = {
  ok: false;
  error: { code: string; message: string };
};

/** Open-request payload: a registered workspace path. */
export interface OpenRequestBody {
  path: string;
  newWindow?: boolean;
}

/** Open-response value. */
export interface OpenResponseValue {
  workspace: { id: string; title: string };
  path: string;
  command: readonly string[];
}

/** Route prefix (same origin as the GUI). */
export const OPEN_ROUTE = '/dsh-open-in-zed/open';

/**
 * Ask the host half to launch zed on a registered workspace directory.
 * @param path - Absolute workspace path (must own a registered workspace).
 * @param options - Optional new-window request and abort signal.
 * @returns the launch record on success.
 * @throws Error with the host's message on any failure shape (network,
 * timeout, non-JSON, envelope error).
 */
export async function openInZed(
  path: string,
  options?: { newWindow?: boolean; signal?: AbortSignal },
): Promise<OpenResponseValue> {
  const body: OpenRequestBody = {
    path,
    ...(options?.newWindow === true ? { newWindow: true } : {}),
  };
  let response: Response;
  try {
    response = await fetch(OPEN_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  } catch (error) {
    throw new Error(
      `dsh-open-in-zed: 网络请求失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw new Error(`dsh-open-in-zed: 读取响应失败 (HTTP ${response.status})`, {
      cause: error,
    });
  }
  if (raw.trim().length === 0) {
    throw new Error(`dsh-open-in-zed: 空响应 (HTTP ${response.status})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`dsh-open-in-zed: 非 JSON 响应 (HTTP ${response.status})`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('ok' in parsed) ||
    typeof (parsed as ApiOk<unknown>).ok !== 'boolean'
  ) {
    throw new Error(`dsh-open-in-zed: 非法响应结构 (HTTP ${response.status})`);
  }
  if ((parsed as ApiFail).ok === false) {
    const fail = parsed as ApiFail;
    throw new Error(
      `dsh-open-in-zed [${fail.error?.code ?? 'unknown'}]: ${
        fail.error?.message ?? '未知错误'
      }`,
    );
  }
  const ok = parsed as ApiOk<OpenResponseValue>;
  return ok.value;
}
