/**
 * 配置卡的自定义 hooks：locale 联动与模型目录加载。
 *
 * @module dsh-llm-fallback/client/hooks
 */

import * as React from 'react';
import type { CatalogGroup, LocaleFace, RemoteSessionFace } from './types.ts';

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

/** 模型目录加载状态机。 */
export type CatalogState =
  | { status: 'idle'; groups: CatalogGroup[] }
  | { status: 'loading'; groups: CatalogGroup[] }
  | { status: 'ready'; groups: CatalogGroup[] }
  | { status: 'error'; groups: CatalogGroup[] };

/**
 * 模型目录加载：挂载后从 remote.session.modelCatalog() 拉取宿主已配置
 * provider 的模型目录（按 provider 分组）；失败可 retry 重拉。
 * 目录数据由回退队列与时段规则目标两处 picker 共享。
 */
export function useModelCatalog(session: RemoteSessionFace | undefined): {
  cat: CatalogState;
  reload: () => void;
} {
  const [cat, setCat] = React.useState<CatalogState>({
    status: 'idle',
    groups: [],
  });

  const load = React.useCallback((): void => {
    setCat((prev) => ({ status: 'loading', groups: prev.groups }));
    Promise.resolve()
      .then(() => session?.modelCatalog())
      .then((response) => {
        if (response && response.ok) {
          setCat({ status: 'ready', groups: response.value?.groups ?? [] });
        } else {
          setCat((prev) => ({ status: 'error', groups: prev.groups }));
        }
      })
      .catch(() => {
        setCat((prev) => ({ status: 'error', groups: prev.groups }));
      });
  }, [session]);

  React.useEffect(() => {
    if (cat.status === 'idle') load();
    return undefined;
  }, [cat.status, load]);

  return { cat, reload: load };
}
