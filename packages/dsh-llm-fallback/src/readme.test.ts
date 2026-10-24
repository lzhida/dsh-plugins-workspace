/**
 * README 一致性防回归测试。
 *
 * README 随包发布(package.json `files` 白名单),承载安装命令、默认配置值
 * 与失败码白名单等用户可直接执行 / 依赖的事实。本测试把这些事实与代码互相
 * 锚定:改实现忘改文档(或文档误删关键信息)时在此处变红,防止文档与行为漂移。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RETRYABLE_CODES } from './config.ts';

const readme = readFileSync(
  fileURLToPath(new URL('../README.md', import.meta.url)),
  'utf8',
);

describe('dsh-llm-fallback README', () => {
  it('不存在旧包名 @lzhida/dsh-llm-fallback 残留', () => {
    expect(readme.includes('@lzhida/dsh-llm-fallback')).toBe(false);
  });

  it('保留开源 README 必备章节(特性 / 安装 / 配置 / 许可证)', () => {
    for (const section of ['## 特性', '## 安装', '## 配置', '## 许可证']) {
      expect(readme).toContain(section);
    }
  });

  it('npm 安装命令与包名一致', () => {
    expect(readme).toContain('dsh plugin add @zhidal/dsh-llm-fallback');
  });

  it('包含 e2e 契约装载日志行 `[dsh-llm-fallback] plugin loaded`', () => {
    expect(readme).toContain('[dsh-llm-fallback] plugin loaded');
  });

  it('失败码白名单覆盖 DEFAULT_RETRYABLE_CODES 全部默认码', () => {
    for (const code of DEFAULT_RETRYABLE_CODES) {
      expect(readme).toContain(code);
    }
  });

  it('失败码白名单锚定网关 408 三态与 status 结构化判定', () => {
    // 网关 408(三态):deepseek 路由两形态(HTTP_408 白名单码 /
    // INVALID_REQUEST + status=408)可切换;pi-ai 路由不透传 status、
    // 插件侧无解;客户端超时 TIMEOUT 恒可切。结构化判定只读字段、
    // 不解析 message,且先于白名单(存量自定义白名单零迁移)。
    expect(readme).toContain('网关 408');
    expect(readme).toContain('`HTTP_408`');
    expect(readme).toContain('`status=408`');
    expect(readme).toContain('`status === 408`');
    expect(readme).toContain('零迁移');
    // pi-ai 路由退化形态必须如实注明为无解,不得暗示插件可路由
    expect(readme).toContain('不透传 `status`');
    expect(readme).toContain('插件侧无解');
  });

  it('已知限制写明 status 数据面差异(仅 deepseek 路由填充)', () => {
    // status 判定的生效范围必须与宿主数据面一致:pi-ai 路由纯文本分类
    // 不产出 status 字段,该路由的网关 408 无法被结构化判定覆盖。
    expect(readme).toContain('仅由 deepseek 路由的 provider 错误路径填充');
    expect(readme).toContain('修复点在宿主上游');
  });

  it('故障排查含「重试 5/5 后失败」分叉解释与白名单逃生风险', () => {
    // 排查段必须给出分叉判定(白名单外 code vs 候选链/预算耗尽)与
    // INVALID_REQUEST 白名单逃生的风险(真构造错误也会变成切换,不推荐)。
    expect(readme).toContain('重试 5/5 耗尽后失败、插件未切换');
    expect(readme).toContain('按结果分叉');
    expect(readme).toContain('**不推荐**');
    expect(readme).toContain('确定性复现');
  });

  it('默认配置值与代码一致(retriesBeforeSwitch 0=跟随预算 / maxRetries 0=链长 / 退避 500-30000ms)', () => {
    expect(readme).toContain('`retriesBeforeSwitch`');
    expect(readme).toContain('`maxRetries`');
    expect(readme).toContain('`0`（= 链长');
    expect(readme).toContain('`500`');
    expect(readme).toContain('`30000`');
  });

  it('配置表不再包含旧回退时机配置 fallbackWhen(0.5.0 起改为每候选重试次数)', () => {
    // 0.5.0 移除 fallbackWhen(afterRetry/immediately 两档),配置面统一为
    // 数值化 retriesBeforeSwitch。配置表/配置值层面若再出现旧字段即为文档
    // 漂移(升级说明语境的"旧字段被忽略"提示除外)。
    expect(readme).not.toContain('| `fallbackWhen`');
    expect(readme).not.toContain("'afterRetry'");
  });

  it('每候选重试次数小节锚定核心语义(自动档跟随官方预算 / 自定义档以插件为准 / 代执行)', () => {
    expect(readme).toContain('## 每候选重试次数（retriesBeforeSwitch）');
    // 自定义档以插件配置为准,不再被 provider 预算封顶
    expect(readme).toContain('以插件为准');
    expect(readme).not.toContain('min(N, retryPolicy.maxRetries)');
    expect(readme).toContain('代执行');
    expect(readme).toContain('dsh-llm-retry');
  });

  it('轨迹可见性小节锚定官方事件通道(llm/retry / retry-started / policyKey)', () => {
    expect(readme).toContain('## 轨迹可见性');
    expect(readme).toContain('`llm/retry`');
    expect(readme).toContain('`llm/retry-started`');
    expect(readme).toContain('llm-fallback'); // policyKey
    // 文档必须说明这是官方已知事件类型,而非插件自创(ignorable 兼容机制)
    expect(readme).toContain('官方已知事件类型');
    // 轨迹编号契约:按 provider 建链、retry 链内连续(format v4 读侧校验),
    // 旧的"每 step 一个 retryId + 切换序号"编号会写出非法序列导致会话无法恢复
    expect(readme).toContain('按**失败 provider** 建链');
    expect(readme).toContain('从 1 起严格连续');
  });

  it('perTurn 已实装:配置表与行为段写明单次切换档,已知限制不再声称未实装', () => {
    // 0.5.x 曾是半成品字段(schema 声明、解析存在、状态机未读);实装后
    // 文档若再出现"预留/未实装"即为文档漂移。
    expect(readme).not.toContain('`perTurn` 尚未实装');
    expect(readme).not.toContain('尚未参与回退判定');
    expect(readme).toContain('至多切换一次');
  });

  it('step 状态表已知限制已更新:写明新 turn 清理与上界,不再声称无界', () => {
    expect(readme).not.toContain('严格意义上无上界');
    expect(readme).toContain('新 turn');
  });

  it('step 状态键含会话标识:写明会话隔离与降级形态,不再声称键不含会话标识', () => {
    // 会话隔离实装后,文档若再声称"键不含会话标识/多会话共享键位现状"
    // 即为漂移;降级形态(缺 agent.session.id → turn:step 共享键位)与
    // 会话粒度遗留上界必须如实注明。
    expect(readme).not.toContain('key 不含会话标识');
    expect(readme).toContain('agent.session.id');
    expect(readme).toContain('同号 turn 互不串扰');
    expect(readme).toContain('`turn:step` 共享键位');
  });

  it('时间窗切换与错峰优先小节锚定核心语义(预填冷却表/官方窗口/本地时区/与冷却关系)', () => {
    // 时段计划 v2(0.6.0):文档必须说清「时间窗=预填冷却表」机制、官方
    // 错峰预置窗口、宿主本地时区语义,以及与失败冷却的关系(同一冷却表
    // 承载、取更晚到期、共用全冷降级兜底)。
    expect(readme).toContain('## 时间窗切换与错峰优先');
    expect(readme).toContain('预填冷却表');
    expect(readme).toContain('惰性过期');
    expect(readme).toContain('08:30–00:30');
    expect(readme).toContain('00:30–08:30');
    expect(readme).toContain('宿主机本地时区');
    expect(readme).toContain('`deepseek-*`');
    expect(readme).toContain('与冷却跳过的关系');
    expect(readme).toContain('绝不吞掉全部候选');
    expect(readme).toContain('`timeWindowEnabled`');
    expect(readme).toContain('`timeWindowRules`');
  });

  it('配置存储与持久化小节锚定落点(profile 补丁层条目 config / per-profile / 重启保留)', () => {
    // 配置持久化落点必须写明:宿主 profile 补丁层 cordis.patch.yml 的条目
    // config,per-profile 隔离 + 重启保留;并写明本插件不引入自有配置文件。
    expect(readme).toContain('### 配置存储与持久化');
    expect(readme).toContain('~/.dsh/profiles/<profile>/cordis.patch.yml');
    expect(readme).toContain('- id: dsh-llm-fallback');
    expect(readme).toContain('per-profile');
    expect(readme).toContain('重启保留');
    expect(readme).toContain('不引入任何自有配置文件或数据目录');
  });

  it('补丁层双角色与手改适用场景已说明(条目注册 / volatile 持久化 / 官方插件同落此层)', () => {
    // 用户两问的正面回答:第三方插件配置为何落在"官方插件的配置文件"里
    // ——同一文件是宿主统一补丁层,官方插件设置同样落此层(以 locale 为例);
    // 手改 patch 文件的适用场景限定为预置配置。
    expect(readme).toContain('补丁层的两个角色');
    expect(readme).toContain('条目注册');
    expect(readme).toContain('volatile 配置持久化');
    expect(readme).toContain('@deepseek-ai/dsh-client-locale');
    expect(readme).toContain('仅限**预置配置**');
    // 组合树分层顺序(bundle → profile → home → CLI overlay)与"只写 profile 层"
    expect(readme).toContain('bundle 层 → profile 层 → home 层');
    expect(readme).toContain('设置面板只写 profile 层');
  });

  it('手改补丁层的生效方式写明 HMR 与重启之分(不得笼统断言"需重启")', () => {
    // HMR 开启的 profile 实时监听补丁层文件、改动即时生效;关掉 HMR 的
    // profile(headless/sdk/acp)才需重启宿主——笼统写"需重启"是错的。
    expect(readme).toContain('开启 HMR 的 profile');
    expect(readme).toContain('需重启宿主实例');
  });

  it('~/.dsh 两类文件区分与状态持久化指向 roadmap 第三档已说明', () => {
    // 宿主托管配置 vs 插件自有数据(JSON/storage)必须各举一例;
    // 状态持久化只引用 roadmap 第三档、不复述结论(防文档漂移)。
    expect(readme).toContain('`~/.dsh` 下的两类文件');
    expect(readme).toContain('宿主托管配置');
    expect(readme).toContain('插件自有数据');
    expect(readme).toContain('dsh-taskboard.json');
    expect(readme).toContain('storages/');
    expect(readme).toContain('docs/llm-fallback-roadmap.md');
    // profile 层(可写落点)与 home 层(机器级只读)的区分
    expect(readme).toContain('~/.dsh/cordis.patch.yml');
  });

  it('故障排查含 fallbackWhen 残留字段无害说明(与零成本升级既有段呼应)', () => {
    // 0.2.x 旧字段 fallbackWhen 在 profile 补丁层残留属预期形态:
    // 插件不识别、不迁移、不影响行为——与"零成本升级"承诺一致。
    expect(readme).toContain('残留 `fallbackWhen: afterRetry`');
    expect(readme).toContain('不会迁移它');
    expect(readme).toContain('零成本升级');
  });

  it('已按开源 README 结构收敛:不再包含版本历史 / 适配版本内部表', () => {
    expect(readme).not.toContain('## 版本历史');
    expect(readme).not.toContain('## 适配版本');
    expect(readme).not.toContain('宿主上游问题');
  });
});
