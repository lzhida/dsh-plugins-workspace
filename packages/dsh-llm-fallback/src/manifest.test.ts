import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** npm 发布元数据里与本包相关的字段形状(只声明测试关心的部分)。 */
interface PackageManifest {
  name: string;
  homepage?: string;
  repository?: {
    type?: string;
    url?: string;
    directory?: string;
  };
}

/** 读包目录下相对文件(与 client-bundle.test.ts 同一模式)。 */
function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

const pkg = JSON.parse(readPackageFile('../package.json')) as PackageManifest;

/** GitHub 仓库内本插件子目录的 URL(npm 官网 Homepage 链接的目标)。 */
const REPO_DIR_URL =
  'https://github.com/lzhida/dsh-plugins-workspace/tree/main/packages/dsh-llm-fallback';

describe('dsh-llm-fallback', () => {
  describe('npm 发布元数据(repository/homepage)', () => {
    it('显式 homepage 指向插件子目录 README,而非 monorepo 根目录', () => {
      // 包缺显式 homepage 时,npm 自动回退生成仓库根目录链接
      // "https://github.com/<owner>/<repo>#readme",官网 Homepage 跳不到
      // 插件目录——@zhidal/dsh-llm-fallback@0.4.0 即如此,此断言防回归。
      expect(pkg.homepage).toBe(`${REPO_DIR_URL}#readme`);
    });

    it('repository 带 directory,仓库链接落到 monorepo 内本插件子目录', () => {
      expect(pkg.repository?.type).toBe('git');
      expect(pkg.repository?.url).toBe(
        'git+https://github.com/lzhida/dsh-plugins-workspace.git',
      );
      expect(pkg.repository?.directory).toBe('packages/dsh-llm-fallback');
    });

    it('homepage 路径与 repository.directory 同源一致(目录迁移时两处须同步改)', () => {
      // 从 homepage URL 提取仓库内目录(去掉 "/lzhida/dsh-plugins-workspace/tree/<分支>/" 前缀),
      // 必须与 repository.directory 相等——若 homepage 退化为根目录链接
      // (pathname 无子目录前缀可剥),提取结果不等,测试失败提醒两处同步。
      const homepage = pkg.homepage ?? '';
      expect(homepage).not.toBe('');
      const directoryFromHomepage = new URL(homepage).pathname
        .replace(/^\/lzhida\/dsh-plugins-workspace\/tree\/[^/]+\//, '')
        .replace(/\/$/, '');
      expect(directoryFromHomepage).toBe(pkg.repository?.directory);
    });
  });
});
