/**
 * decision-tools 设置页主卡（决策工具系列 6/11）。
 *
 * 结构照抄 llm-fallback FallbackCard：summary 视图只出一行说明；page 视图
 * 按 1/11 设计稿分区（A 模型接口+验证 / B 十工具开关 / C 预算 / D 兜底 /
 * E 账本与闸门）+ 底部保存条。状态机：configForms 快照订阅 + 单一草稿 +
 * 脏检查保存闸 + 验证状态机（lib/verify 纯函数）。
 *
 * @module dsh-decision/client/components/decision-card
 */

import * as React from 'react';

import {
  TOOL_SWITCH_FIELDS,
  TOOL_SWITCH_LABEL_KEYS,
  VERIFY_ROUTE_PATH,
} from '../constants.ts';
import { staticT } from '../dict.ts';
import {
  beginDraft,
  buildMutations,
  FALLBACK_MODES,
  isDirty,
  readSavedSettings,
  resolveView,
  type SavedSettings,
} from '../lib/settings.ts';
import {
  applyVerifyFailure,
  applyVerifyResponse,
  INITIAL_VERIFY_STATUS,
  requestVerify,
  startVerify,
  type VerifyStatus,
} from '../lib/verify.ts';
import type { CardProps, ConfigScope } from '../types.ts';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';
import {
  FloatRow,
  NumberRow,
  SelectRow,
  SwitchRow,
  TextRow,
} from './fields.tsx';

export interface DecisionCardProps extends CardProps {
  /** configForms scope（plugin.tsx 注入）。 */
  scope: ConfigScope;
}

/** 渲染入口（summary 视图不进 hooks——保持 llm-fallback 同款守卫）。 */
export function DecisionCard(props: DecisionCardProps): React.ReactElement {
  if (props.view === 'summary') {
    const t = props.t ?? staticT;
    return (
      <div className="text-[13px] text-muted-foreground">
        {t('page.description')}
      </div>
    );
  }
  return <DecisionCardPage {...props} />;
}

function DecisionCardPage(props: DecisionCardProps): React.ReactElement {
  const t = props.t ?? staticT;
  const { scope } = props;
  const [snap, setSnap] = React.useState(() => scope.getSnapshot());
  const [draft, setDraft] = React.useState<ReturnType<
    typeof beginDraft
  > | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [verifyStatus, setVerifyStatus] = React.useState<VerifyStatus>(
    INITIAL_VERIFY_STATUS,
  );

  React.useEffect(() => {
    const unsubscribe = scope.subscribe(() => setSnap(scope.getSnapshot()));
    return unsubscribe;
  }, [scope]);

  const saved: SavedSettings = React.useMemo(
    () => readSavedSettings(snap.value, snap.revision),
    [snap.value, snap.revision],
  );
  const view = resolveView(saved, draft);
  const dirty = isDirty(view, saved);
  const readonly = snap.writable !== true;

  const update = (
    key: keyof typeof view,
    value: boolean | number | string,
  ): void => {
    setErrorMsg(null);
    setDraft((current) => {
      const base = current ?? beginDraft(saved);
      return {
        revision: base.revision,
        values: { ...base.values, [key]: value },
      };
    });
  };

  const save = (): void => {
    if (busy || !dirty) return;
    const target = draft;
    if (target === null) return;
    setBusy(true);
    setErrorMsg(null);
    setConflict(false);
    scope
      .mutate(buildMutations(target.values), target.revision)
      .then(() => {
        setDraft(null);
        setBusy(false);
        setSnap(scope.getSnapshot());
      })
      .catch((error: unknown) => {
        setBusy(false);
        const message = error instanceof Error ? error.message : String(error);
        // 只有版本冲突才是「冲突」；其余错误是保存失败（样板 FallbackCard 同款判定）。
        const code = (error as { code?: unknown } | null)?.code;
        const isConflict = code === 'SETTINGS_CONFLICT';
        setConflict(isConflict);
        setErrorMsg(
          isConflict
            ? t('common.conflict')
            : message.length > 0
              ? message
              : t('common.error'),
        );
      });
  };

  /**
   * 验证结果回写（契约 §6.2：验证动作写 systemoneVerifiedAt / systemoneVerifyError）。
   * 只写这两个状态字段——**绝不回写 apiKey**；回写失败不打断 UI 流程。
   * 回写成功后宿主 revision 会 bump：打开中的草稿必须同步到新 revision，
   * 否则「先验证草稿、再保存」必然 SETTINGS_CONFLICT（V2 复审 major 修复）。
   */
  const persistVerifyState = (
    verifiedAt: string,
    verifyError: string,
  ): void => {
    const current = scope.getSnapshot();
    scope
      .mutate(
        [
          { op: 'set', path: ['systemoneVerifiedAt'], value: verifiedAt },
          { op: 'set', path: ['systemoneVerifyError'], value: verifyError },
        ],
        current.revision,
      )
      .then(() => {
        const fresh = scope.getSnapshot();
        setSnap(fresh);
        // 草稿保留用户未保存的字段改动，仅把 revision 对齐宿主最新值。
        setDraft((currentDraft) => {
          if (currentDraft === null) return null;
          return { ...currentDraft, revision: fresh.revision };
        });
      })
      .catch(() => {
        /* 回写失败不阻断：宿主侧已用进程内快照置为 verified。 */
      });
  };

  /** 失败原因取人类文案（routeMissing 的稳定 key 不落配置）。 */
  const persistReason = (next: VerifyStatus, fallback: string): string => {
    if (next.phase !== 'fail') return fallback.slice(0, 300);
    const text =
      next.routeMissing === true ? t('verify.route-missing') : next.reason;
    return text.slice(0, 300);
  };

  const verify = (): void => {
    if (verifyStatus.phase === 'verifying') return;
    setVerifyStatus(startVerify());
    requestVerify(VERIFY_ROUTE_PATH, {
      baseUrl: view.systemoneBaseUrl,
      apiKey: view.systemoneApiKey,
      model: view.systemoneModel,
      timeoutMs: view.systemoneTimeoutMs,
    })
      .then((response) => {
        const next = applyVerifyResponse(response);
        setVerifyStatus(next);
        if (next.phase === 'ok') {
          persistVerifyState(new Date().toISOString(), '');
        } else if (next.phase === 'fail') {
          persistVerifyState('', persistReason(next, next.reason));
        }
      })
      .catch((error: unknown) => {
        const next = applyVerifyFailure(error);
        setVerifyStatus(next);
        persistVerifyState('', persistReason(next, String(error)));
      });
  };

  const sectionTitleClass = 'mt-4 text-[13px] font-semibold text-foreground';

  return (
    <div className="flex flex-col gap-1 pb-2 text-[13px] text-foreground">
      <p className="text-xs leading-5 text-muted-foreground">
        {t('page.description')}
      </p>

      {/* A. 决策模型接口 */}
      <h3 className={sectionTitleClass}>{t('section.model')}</h3>
      <TextRow
        id="dt-base-url"
        label={t('field.baseUrl')}
        hint={t('field.baseUrl.hint')}
        value={view.systemoneBaseUrl}
        placeholder="https://decision.example.internal"
        disabled={readonly || busy}
        onChange={(value) => update('systemoneBaseUrl', value)}
      />
      <TextRow
        id="dt-api-key"
        label={t('field.apiKey')}
        hint={t('field.apiKey.hint')}
        value={view.systemoneApiKey}
        secret
        disabled={readonly || busy}
        onChange={(value) => update('systemoneApiKey', value)}
      />
      <TextRow
        id="dt-model"
        label={t('field.model')}
        hint={t('field.model.hint')}
        value={view.systemoneModel}
        placeholder="local-decision-model"
        disabled={readonly || busy}
        onChange={(value) => update('systemoneModel', value)}
      />
      <NumberRow
        id="dt-timeout"
        label={t('field.timeoutMs')}
        hint={t('field.timeoutMs.hint')}
        value={view.systemoneTimeoutMs}
        min={1000}
        max={300000}
        disabled={readonly || busy}
        onChange={(value) => update('systemoneTimeoutMs', value)}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-1.5">
        <Button
          size="sm"
          onClick={verify}
          disabled={verifyStatus.phase === 'verifying'}
        >
          {verifyStatus.phase === 'verifying'
            ? t('verify.verifying')
            : t('verify.button')}
        </Button>
        {verifyStatus.phase === 'ok' ? (
          <Badge
            variant="success"
            className="max-w-full overflow-hidden"
            title={`${t('verify.ok')} · ${verifyStatus.model ?? ''} · ${verifyStatus.latencyMs}ms`}
          >
            <span className="truncate">
              {t('verify.ok')}
              {verifyStatus.model === null
                ? ''
                : ` · ${verifyStatus.model}`} · {t('verify.ok.latency')}{' '}
              {verifyStatus.latencyMs}ms
            </span>
          </Badge>
        ) : null}
        {verifyStatus.phase === 'fail' ? (
          <Badge
            variant="outline"
            className="max-w-full overflow-hidden text-destructive"
            title={
              verifyStatus.routeMissing
                ? t('verify.route-missing')
                : `${t('verify.fail')} · ${verifyStatus.reason}`
            }
          >
            <span className="truncate">
              {verifyStatus.routeMissing
                ? t('verify.route-missing')
                : `${t('verify.fail')} · ${verifyStatus.reason}`}
            </span>
          </Badge>
        ) : null}
      </div>

      {saved.systemoneVerifiedAt !== '' || saved.systemoneVerifyError !== '' ? (
        <p className="text-xs leading-4 text-muted-foreground">
          {saved.systemoneVerifiedAt !== ''
            ? `${t('verify.last-verified')} ${saved.systemoneVerifiedAt}`
            : `${t('verify.last-error')} ${saved.systemoneVerifyError}`}
        </p>
      ) : null}

      {/* B. 工具开关 */}
      <h3 className={sectionTitleClass}>{t('section.tools')}</h3>
      <p className="text-xs leading-4 text-muted-foreground">
        {t('hint.tools')}
      </p>
      {TOOL_SWITCH_FIELDS.map((field) => (
        <SwitchRow
          key={field}
          label={t(TOOL_SWITCH_LABEL_KEYS[field])}
          checked={view[field]}
          disabled={readonly || busy}
          onChange={(checked) => update(field, checked)}
        />
      ))}

      {/* C. 预算 */}
      <h3 className={sectionTitleClass}>{t('section.budget')}</h3>
      <SwitchRow
        label={t('field.budgetEnabled')}
        hint={t('field.budgetEnabled.hint')}
        checked={view.budgetEnabled}
        disabled={readonly || busy}
        onChange={(checked) => update('budgetEnabled', checked)}
      />
      <NumberRow
        id="dt-budget-calls"
        label={t('field.budgetMaxCallsPerDay')}
        value={view.budgetMaxCallsPerDay}
        min={0}
        disabled={readonly || busy}
        onChange={(value) => update('budgetMaxCallsPerDay', value)}
      />
      <NumberRow
        id="dt-budget-tokens"
        label={t('field.budgetMaxTokensPerDay')}
        value={view.budgetMaxTokensPerDay}
        min={0}
        disabled={readonly || busy}
        onChange={(value) => update('budgetMaxTokensPerDay', value)}
      />
      <FloatRow
        id="dt-budget-cost"
        label={t('field.budgetMaxCostUsdPerDay')}
        value={view.budgetMaxCostUsdPerDay}
        disabled={readonly || busy}
        onChange={(value) => update('budgetMaxCostUsdPerDay', value)}
      />
      <NumberRow
        id="dt-budget-reset"
        label={t('field.budgetResetHourUtc')}
        hint={t('field.budgetResetHourUtc.hint')}
        value={view.budgetResetHourUtc}
        min={0}
        max={23}
        disabled={readonly || busy}
        onChange={(value) => update('budgetResetHourUtc', value)}
      />
      <FloatRow
        id="dt-cost-input"
        label={t('field.costInputPer1kTokens')}
        value={view.costInputPer1kTokens}
        disabled={readonly || busy}
        onChange={(value) => update('costInputPer1kTokens', value)}
      />
      <FloatRow
        id="dt-cost-output"
        label={t('field.costOutputPer1kTokens')}
        hint={t('hint.cost')}
        value={view.costOutputPer1kTokens}
        disabled={readonly || busy}
        onChange={(value) => update('costOutputPer1kTokens', value)}
      />

      {/* D. 大模型兜底（参数区；裁判逻辑 7/11 落地） */}
      <h3 className={sectionTitleClass}>{t('section.fallback')}</h3>
      <SwitchRow
        label={t('field.fallbackEnabled')}
        hint={t('field.fallbackEnabled.hint')}
        checked={view.fallbackEnabled}
        disabled={readonly || busy}
        onChange={(checked) => update('fallbackEnabled', checked)}
      />
      <TextRow
        id="dt-fallback-provider"
        label={t('field.fallbackProvider')}
        hint={t('field.fallbackProvider.hint')}
        value={view.fallbackProvider}
        disabled={readonly || busy}
        onChange={(value) => update('fallbackProvider', value)}
      />
      <TextRow
        id="dt-fallback-model"
        label={t('field.fallbackModel')}
        hint={t('field.fallbackModel.hint')}
        value={view.fallbackModel}
        disabled={readonly || busy}
        onChange={(value) => update('fallbackModel', value)}
      />
      <FloatRow
        id="dt-fallback-min-confidence"
        label={t('field.fallbackMinConfidence')}
        hint={t('field.fallbackMinConfidence.hint')}
        value={view.fallbackMinConfidence}
        disabled={readonly || busy}
        onChange={(value) => update('fallbackMinConfidence', value)}
      />
      <SelectRow
        id="dt-fallback-mode"
        label={t('field.fallbackMode')}
        hint={t('field.fallbackMode.hint')}
        value={view.fallbackMode}
        options={FALLBACK_MODES.map((mode) => ({ value: mode, label: mode }))}
        disabled={readonly || busy}
        onChange={(value) => update('fallbackMode', value)}
      />
      <NumberRow
        id="dt-fallback-timeout"
        label={t('field.fallbackTimeoutMs')}
        value={view.fallbackTimeoutMs}
        min={1000}
        disabled={readonly || busy}
        onChange={(value) => update('fallbackTimeoutMs', value)}
      />
      <NumberRow
        id="dt-fallback-max-calls"
        label={t('field.fallbackMaxCallsPerDay')}
        hint={t('hint.fallback')}
        value={view.fallbackMaxCallsPerDay}
        min={0}
        disabled={readonly || busy}
        onChange={(value) => update('fallbackMaxCallsPerDay', value)}
      />

      {/* E. 账本与闸门 */}
      <h3 className={sectionTitleClass}>{t('section.ledger')}</h3>
      <SwitchRow
        label={t('field.ledgerEnabled')}
        hint={t('field.ledgerEnabled.hint')}
        checked={view.ledgerEnabled}
        disabled={readonly || busy}
        onChange={(checked) => update('ledgerEnabled', checked)}
      />
      <NumberRow
        id="dt-ledger-max"
        label={t('field.ledgerMaxEntries')}
        value={view.ledgerMaxEntries}
        min={0}
        disabled={readonly || busy}
        onChange={(value) => update('ledgerMaxEntries', value)}
      />
      <FloatRow
        id="dt-gate-threshold"
        label={t('field.gateAllowThreshold')}
        hint={t('field.gateAllowThreshold.hint')}
        value={view.gateAllowThreshold}
        disabled={readonly || busy}
        onChange={(value) => update('gateAllowThreshold', value)}
      />

      {/* 底部保存条 */}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
        <Button size="sm" onClick={save} disabled={readonly || busy || !dirty}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        {dirty ? <Badge variant="outline">{t('common.unsaved')}</Badge> : null}
        {!dirty && errorMsg === null ? (
          <Badge variant="outline">{t('common.saved')}</Badge>
        ) : null}
        {conflict ? (
          <Badge variant="outline" className="text-destructive">
            {t('common.conflict')}
          </Badge>
        ) : null}
        {errorMsg !== null ? (
          <span className="text-xs text-destructive">{errorMsg}</span>
        ) : null}
        {readonly ? (
          <span className="text-xs text-muted-foreground">
            {t('common.readonly')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
