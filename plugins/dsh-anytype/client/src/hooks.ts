/**
 * 配置卡的自定义 hooks：locale 联动、条目快照订阅、secret 槽位状态。
 *
 * @module dsh-anytype/client/hooks
 */

import * as React from 'react';
import type {
  ConfigScope,
  ConfigSnapshot,
  DescribeFace,
  LocaleFace,
} from './types.ts';

/**
 * 语言联动：订阅 locale 快照（LocaleFace 的 getSnapshot/subscribe 契约），
 * revision 变化（切换语言 / 字典注册）时 bump 本地计数强制重渲染，让本卡
 * 文案立即跟随 设置 → 通用 → 语言 的当前选择。
 *
 * locale 服务缺失（组合未含 dsh-client-locale）时跳过订阅——静态英文回退
 * 路径无需联动。返回的 tick 值仅用于触发重渲染，无语义。
 */
export function useLocaleTick(locale: LocaleFace | undefined): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (
      !locale ||
      typeof locale.subscribe !== 'function' ||
      typeof locale.getSnapshot !== 'function'
    ) {
      return undefined;
    }
    let last = locale.getSnapshot().revision;
    return locale.subscribe(() => {
      const next = locale.getSnapshot().revision;
      if (next === last) return;
      last = next;
      setTick((n) => n + 1);
    });
  }, [locale]);
  return tick;
}

/**
 * 条目配置快照订阅：宿主每次接受写入 / 别处改动都推一次新快照。
 * 快照对象在下次变更前保持引用稳定（可直接进 useMemo 依赖）。
 */
export function useConfigSnapshot(scope: ConfigScope): ConfigSnapshot {
  const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());
  React.useEffect(
    () => scope.subscribe(() => setSnapshot(scope.getSnapshot())),
    [scope],
  );
  return snapshot;
}

/**
 * secret 槽位状态：宿主在 describe 视图里报告「该字段是否已设置」——值本身
 * 永不过线（`role('secret')` 脱敏）。密钥行据此显示「已配置 / 未配置」。
 *
 * @param describe - 跨 namespace 只读面。
 * @param ns - 目标 namespace（profile 条目 id）。
 * @param path - secret 槽位路径（如 `['apiKey']`）。
 */
export function useSecretSlot(
  describe: DescribeFace | undefined,
  ns: string,
  path: readonly string[],
): boolean {
  const read = (): boolean => {
    const view = describe?.getSnapshot().view;
    if (!view) return false;
    const namespace = view.namespaces.find((item) => item.ns === ns);
    if (!namespace) return false;
    const slot = namespace.secrets.find(
      (item) =>
        item.path.length === path.length &&
        item.path.every((segment, index) => segment === path[index]),
    );
    return slot?.set === true;
  };
  const [set, setSet] = React.useState<boolean>(read);
  React.useEffect(() => {
    if (!describe) return undefined;
    const sync = (): void => setSet(read());
    sync();
    return describe.subscribe(sync);
  }, [describe, ns, path.join('.')]);
  return set;
}
