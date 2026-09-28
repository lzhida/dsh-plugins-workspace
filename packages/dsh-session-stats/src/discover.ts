import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 发现的会话文件元信息。 */
export interface SessionFileInfo {
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

/** 解析 DSH 主目录（默认 ~/.dsh，可用 DSH_HOME 覆盖）。 */
export function resolveDshHome(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return path.resolve(explicit);
  const fromEnv = process.env['DSH_HOME'];
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

const SESSION_LOG_NAMES = new Set([
  'session.v4.jsonl.zstd',
  'session.v4.jsonl',
]);

/** 列出 `<root>/sessions/<project>/<session>/` 两级目录下的会话日志文件。 */
function scanSessionsRoot(root: string, out: SessionFileInfo[]): void {
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const project of projectDirs) {
    const projectDir = path.join(root, project);
    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const session of sessionDirs) {
      const sessionDir = path.join(projectDir, session);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !SESSION_LOG_NAMES.has(entry.name)) continue;
        const absolutePath = path.join(sessionDir, entry.name);
        try {
          const stat = fs.statSync(absolutePath);
          out.push({ absolutePath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // 文件刚被清理：跳过。
        }
      }
    }
  }
}

/**
 * 发现全部本地会话文件：
 * - `<home>/sessions/**`（默认 profile）
 * - `<home>/profiles/<name>/sessions/**`（其余 profile，如存在）
 */
export function discoverSessionFiles(dshHome: string): SessionFileInfo[] {
  const out: SessionFileInfo[] = [];
  scanSessionsRoot(path.join(dshHome, 'sessions'), out);
  const profilesDir = path.join(dshHome, 'profiles');
  let profiles: string[];
  try {
    profiles = fs.readdirSync(profilesDir);
  } catch {
    return out;
  }
  for (const profile of profiles) {
    if (profile === 'node_modules') continue;
    const profileSessions = path.join(profilesDir, profile, 'sessions');
    try {
      if (!fs.statSync(profileSessions).isDirectory()) continue;
    } catch {
      continue;
    }
    scanSessionsRoot(profileSessions, out);
  }
  out.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
  return out;
}
