/**
 * 配置卡容器：bundle 页面的完整配置表单（两个插件行 + 保存操作区）。
 *
 * 渲染位：
 * - `view === 'summary'`：一句话说明（提前返回，符合 hooks 规则）；
 * - 其余（`view === 'page'`）：bundle 详情页的完整表单——「Anytype 连接」
 *   与「持久记忆」两个分区，各带保存/放弃操作区。
 *
 * 状态模型：
 * - 两个插件行各有一个 scope（namespace = profile 条目 id）：`dsh-anytype`
 *   （连接类）与 `dsh-anytype-memory`（记忆语义类）；
 * - 单一草稿对象/行（null = 无未保存编辑），脏检查 = 草稿存在且有变更；
 * - 写入栅栏：草稿建立时的 revision 与最新快照 revision 不一致 ⇒ 冲突
 *   （客户端闸）；写入时把 revision 作为 expectedRevision 回带（宿主闸）；
 * - 密钥字段是**只写**的（宿主 `role('secret')` 脱敏，旧值永不过线）：
 *   徽标只报「是否已设置」，留空 = 不改动，**绝不**写空串清掉密钥；
 * - locale 快照订阅（useLocaleTick）驱动语言切换即时重渲染。
 *
 * 样式体系：Tailwind 工具类（shadcn/ui 语义 token，theme.css 映射宿主
 * --dsw-alias-*），文本色在卡片根节点显式声明，不依赖宿主容器继承链。
 *
 * @module dsh-anytype/client/components/AnytypeCard
 */

import * as React from 'react';
import { ROW_MAIN, ROW_MEMORY } from '../constants.ts';
import { useConfigSnapshot, useLocaleTick, useSecretSlot } from '../hooks.ts';
import {
  ANYTYPE_GROUPS,
  buildMainOps,
  buildMemoryOps,
  isDirtyMain,
  isDirtyMemory,
  isValidBaseUrl,
  MEMORY_GROUPS,
  mergeMain,
  mergeMemory,
  readMainValues,
  readMemoryValues,
  type ApiKeyEdit,
  type MainDraft,
  type MemoryDraft,
} from '../lib/settings.ts';
import type {
  CardProps,
  ConfigFormsFace,
  ConfigScope,
  LocaleFace,
  TFn,
} from '../types.ts';
import {
  GroupRow,
  NumberRow,
  SecretRow,
  SwitchRow,
  TextRow,
} from './fields.tsx';
import { Button } from './ui/button.tsx';

/** 配置卡 props（t 由 plugin 层注入；configForms 来自客户端上下文）。 */
export interface AnytypeCardProps extends CardProps {
  t: TFn;
  configForms: ConfigFormsFace;
  /** locale 服务（组合未含 dsh-client-locale 时缺省——静态英文回退）。 */
  locale?: LocaleFace;
}

/** 配置卡入口：按 view 分发（summary 不进 hooks）。 */
export function AnytypeCard(props: AnytypeCardProps): React.ReactElement {
  if (props.view === 'summary') {
    return <span>{props.t('intro')}</span>;
  }
  return <AnytypeCardPage {...props} />;
}

/** 保存错误态（conflict = revision 冲突；invalid = 地址非法；failed = 宿主拒绝/异常）。 */
type SaveError = 'conflict' | 'failed' | 'invalid' | null;

/** 完整配置表单（page 视图）。 */
function AnytypeCardPage(props: AnytypeCardProps): React.ReactElement {
  const { t, configForms, locale } = props;

  // 语言联动（bump 重渲染）。
  useLocaleTick(locale);

  // 两个插件行各一个 scope（namespace = profile 条目 id）。
  const describe = React.useMemo(() => configForms.describe(), [configForms]);
  const mainScope = React.useMemo(
    () => configForms.get(ROW_MAIN),
    [configForms],
  );
  const memoryScope = React.useMemo(
    () => configForms.get(ROW_MEMORY),
    [configForms],
  );

  // 配置快照订阅（宿主接受写入 / 别处改动都会推新快照）。
  const mainSnap = useConfigSnapshot(mainScope);
  const memorySnap = useConfigSnapshot(memoryScope);

  // 密钥槽位状态（值永不过线，只报是否已设置）。
  const apiKeySet = useSecretSlot(describe, ROW_MAIN, ['apiKey']);

  // 草稿与操作态。
  const [mainDraft, setMainDraft] = React.useState<MainDraft | null>(null);
  const [memoryDraft, setMemoryDraft] = React.useState<MemoryDraft | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<SaveError>(null);

  const writable = mainSnap.writable && memorySnap.writable;

  // 已保存视图 + 草稿叠加。
  const savedMain = React.useMemo(
    () => readMainValues(mainSnap.value),
    [mainSnap.value],
  );
  const savedMemory = React.useMemo(
    () => readMemoryValues(memorySnap.value),
    [memorySnap.value],
  );
  const mainView = mergeMain(savedMain, mainDraft);
  const memoryView = mergeMemory(savedMemory, memoryDraft);

  const mainDirty = isDirtyMain(mainDraft);
  const memoryDirty = isDirtyMemory(memoryDraft);
  const dirty = mainDirty || memoryDirty;

  /** 取当前草稿（无草稿则新建——带上建立时的 revision 作写入栅栏）。 */
  function ensureMainDraft(): MainDraft {
    const base = mainDraft ?? {
      revision: mainSnap.revision,
      fields: {},
      apiKey: { mode: 'keep' } as ApiKeyEdit,
    };
    if (mainDraft === null) setMainDraft(base);
    return base;
  }

  /** 插件行①字段编辑（函数式收口：所有编辑先 ensure 再覆盖字段）。 */
  function patchMain(patch: (base: MainDraft) => Partial<MainDraft>): void {
    const base = ensureMainDraft();
    const next = patch(base);
    // fields 按字段合并（多次编辑互不覆盖）；其余键整体替换。
    setMainDraft({
      ...base,
      ...next,
      fields: { ...base.fields, ...(next.fields ?? {}) },
    });
    setError(null);
  }

  /** 插件行②字段编辑。 */
  function patchMemory(
    patch: (base: MemoryDraft) => Partial<MemoryDraft>,
  ): void {
    const base = memoryDraft ?? { revision: memorySnap.revision, fields: {} };
    if (memoryDraft === null) setMemoryDraft(base);
    const next = patch(base);
    setMemoryDraft({
      ...base,
      ...next,
      fields: { ...base.fields, ...(next.fields ?? {}) },
    });
    setError(null);
  }

  /** 工具组勾选切换（两行各一份，组名单不同）。 */
  function toggleGroup(row: 'main' | 'memory', group: string): void {
    if (row === 'main') {
      const current = mainView.disabledGroups;
      const next = current.includes(group)
        ? current.filter((item) => item !== group)
        : [...current, group];
      patchMain(() => ({ fields: { disabledGroups: next } }));
      return;
    }
    const current = memoryView.disabledGroups;
    const next = current.includes(group)
      ? current.filter((item) => item !== group)
      : [...current, group];
    patchMemory(() => ({ fields: { disabledGroups: next } }));
  }

  /** 密钥输入：非空即「写入新值」；留空 = 不改动（载荷不含 apiKey）。 */
  function changeApiKey(value: string): void {
    patchMain(() => ({ apiKey: { mode: 'set', value } }));
  }

  /** 显式清除密钥（unset op，回落组合层默认值）。 */
  function clearApiKey(): void {
    patchMain(() => ({ apiKey: { mode: 'unset' } }));
  }

  function discard(): void {
    setMainDraft(null);
    setMemoryDraft(null);
    setError(null);
  }

  async function save(): Promise<void> {
    if (busy || !writable) return;
    // 客户端冲突闸：草稿建立后 revision 变了 → 别处已改，请放弃草稿。
    if (mainDirty && mainDraft && mainSnap.revision !== mainDraft.revision) {
      setError('conflict');
      return;
    }
    if (
      memoryDirty &&
      memoryDraft &&
      memorySnap.revision !== memoryDraft.revision
    ) {
      setError('conflict');
      return;
    }
    // 地址合法性闸：空/非 http(s) 的地址会被服务端静默回落默认——拦下来更诚实。
    if (mainDirty && !isValidBaseUrl(mainView.baseUrl)) {
      setError('invalid');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 顺序写入：插件行①失败则不写②（避免半配置态）。
      if (mainDirty && mainDraft) {
        const ok = await saveRow(
          mainScope,
          buildMainOps(mainDraft),
          mainDraft.revision,
        );
        if (!ok) {
          setBusy(false);
          setError('failed');
          return;
        }
      }
      if (memoryDirty && memoryDraft) {
        const ok = await saveRow(
          memoryScope,
          buildMemoryOps(memoryDraft),
          memoryDraft.revision,
        );
        if (!ok) {
          setBusy(false);
          setError('failed');
          return;
        }
      }
      setBusy(false);
      discard();
    } catch {
      setBusy(false);
      setError('failed');
    }
  }

  // 两行都没就绪时只给提示（不渲染表单）。
  if (mainSnap.status === 'loading' || memorySnap.status === 'loading') {
    return (
      <div className="py-1 text-[13px] text-muted-foreground">
        {t('loading')}
      </div>
    );
  }
  if (mainSnap.status !== 'ready' && memorySnap.status !== 'ready') {
    return (
      <div className="py-1 text-[13px] text-muted-foreground">
        {t('unavailable')}
      </div>
    );
  }

  const disabled = !writable || busy;
  const baseUrlInvalid = !isValidBaseUrl(mainView.baseUrl);

  const statusText: string | null = !writable
    ? t('readonly')
    : error === 'conflict'
      ? t('conflict')
      : error === 'invalid'
        ? t('invalidBaseUrl')
        : error === 'failed'
          ? t('failed')
          : busy
            ? t('saving')
            : dirty
              ? t('dirty')
              : null;

  return (
    <div className="flex flex-col gap-4 py-1 text-foreground">
      <div className="text-[13px] text-muted-foreground">{t('intro')}</div>

      {mainSnap.status === 'ready' ? (
        <section className="flex flex-col gap-3">
          <h4 className="text-[13px] font-semibold text-foreground">
            {t('sectionConnection')}
          </h4>
          <SwitchRow
            checked={mainView.enabled}
            disabled={disabled}
            onChange={() =>
              patchMain(() => ({ fields: { enabled: !mainView.enabled } }))
            }
            label={t('enabled')}
            hint={t('enabledDesc')}
          />
          <TextRow
            label={t('baseUrl')}
            hint={t('baseUrlDesc')}
            value={mainView.baseUrl}
            disabled={disabled}
            invalid={baseUrlInvalid}
            onChange={(value) =>
              patchMain(() => ({ fields: { baseUrl: value } }))
            }
          />
          <SecretRow
            label={t('apiKey')}
            hint={t('apiKeyDesc')}
            value={
              mainDraft?.apiKey.mode === 'set' ? mainDraft.apiKey.value : ''
            }
            disabled={disabled}
            set={apiKeySet}
            placeholder={t('apiKeyPlaceholder')}
            setLabel={t('apiKeySet')}
            unsetLabel={t('apiKeyUnset')}
            clearLabel={t('apiKeyClear')}
            onChange={changeApiKey}
            onClear={clearApiKey}
          />
          <div className="text-xs text-muted-foreground">{t('apiKeyNote')}</div>
          <TextRow
            label={t('apiVersion')}
            hint={t('apiVersionDesc')}
            value={mainView.apiVersion}
            disabled={disabled}
            onChange={(value) =>
              patchMain(() => ({ fields: { apiVersion: value } }))
            }
          />
          <NumberRow
            label={t('requestTimeoutMs')}
            hint={t('requestTimeoutMsDesc')}
            value={mainView.requestTimeoutMs}
            disabled={disabled}
            onChange={(value) =>
              patchMain(() => ({ fields: { requestTimeoutMs: value } }))
            }
          />
          <NumberRow
            label={t('maxResponseChars')}
            hint={t('maxResponseCharsDesc')}
            value={mainView.maxResponseChars}
            disabled={disabled}
            onChange={(value) =>
              patchMain(() => ({ fields: { maxResponseChars: value } }))
            }
          />
          <GroupRow
            label={t('disabledGroups')}
            hint={t('disabledGroupsDesc')}
            groups={ANYTYPE_GROUPS}
            selected={mainView.disabledGroups}
            disabled={disabled}
            onToggle={(group) => toggleGroup('main', group)}
          />
        </section>
      ) : null}

      {memorySnap.status === 'ready' ? (
        <section className="flex flex-col gap-3">
          <h4 className="text-[13px] font-semibold text-foreground">
            {t('sectionMemory')}
          </h4>
          <SwitchRow
            checked={memoryView.enabled}
            disabled={disabled}
            onChange={() =>
              patchMemory(() => ({
                fields: { enabled: !memoryView.enabled },
              }))
            }
            label={t('memoryEnabled')}
            hint={t('memoryEnabledDesc')}
          />
          <TextRow
            label={t('spaceName')}
            hint={t('spaceNameDesc')}
            value={memoryView.spaceName}
            disabled={disabled}
            onChange={(value) =>
              patchMemory(() => ({ fields: { spaceName: value } }))
            }
          />
          <TextRow
            label={t('spaceId')}
            hint={t('spaceIdDesc')}
            value={memoryView.spaceId}
            disabled={disabled}
            onChange={(value) =>
              patchMemory(() => ({ fields: { spaceId: value } }))
            }
          />
          <TextRow
            label={t('defaultStatus')}
            hint={t('defaultStatusDesc')}
            value={memoryView.defaultStatus}
            disabled={disabled}
            onChange={(value) =>
              patchMemory(() => ({ fields: { defaultStatus: value } }))
            }
          />
          <NumberRow
            label={t('recallLimit')}
            hint={t('recallLimitDesc')}
            value={memoryView.recallLimit}
            disabled={disabled}
            onChange={(value) =>
              patchMemory(() => ({ fields: { recallLimit: value } }))
            }
          />
          <NumberRow
            label={t('recallMaxTokens')}
            hint={t('recallMaxTokensDesc')}
            value={memoryView.recallMaxTokens}
            disabled={disabled}
            onChange={(value) =>
              patchMemory(() => ({ fields: { recallMaxTokens: value } }))
            }
          />
          <NumberRow
            label={t('embeddingBatchSize')}
            hint={t('embeddingBatchSizeDesc')}
            value={memoryView.embeddingBatchSize}
            disabled={disabled}
            onChange={(value) =>
              patchMemory(() => ({ fields: { embeddingBatchSize: value } }))
            }
          />
          <GroupRow
            label={t('memoryDisabledGroups')}
            hint={t('memoryDisabledGroupsDesc')}
            groups={MEMORY_GROUPS}
            selected={memoryView.disabledGroups}
            disabled={disabled}
            onToggle={(group) => toggleGroup('memory', group)}
          />
        </section>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] text-muted-foreground">{statusText}</div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dirty || busy} onClick={discard}>
            {t('discard')}
          </Button>
          <Button disabled={!dirty || busy || !writable} onClick={save}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 写一行配置：宿主接受返回 true；拒绝/异常返回 false。 */
async function saveRow(
  scope: ConfigScope,
  ops: Parameters<ConfigScope['mutate']>[0],
  revision: number | undefined,
): Promise<boolean> {
  const accepted = await scope.mutate(ops, revision);
  return accepted;
}
