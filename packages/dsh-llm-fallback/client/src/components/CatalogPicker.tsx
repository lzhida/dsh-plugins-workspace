/**
 * 模型目录 picker：搜索框 + 限高滚动列表 + 勾选。
 *
 * 回退队列与时段规则目标共用同一目录组件（旧版 catalogElement 复用体的
 * 组件化），仅选中集 / 点选回调 / 搜索词 / 提示文案不同；目录数据
 * （groups/status/retry）由父级 useModelCatalog 提供并两处共享。
 *
 * @module dsh-llm-fallback/client/components/CatalogPicker
 */

import * as React from 'react';
import { filteredCatalogGroups } from '../lib/catalog.ts';
import type { CatalogGroup, TFn } from '../types.ts';
import { S } from '../styles.ts';

/** picker 的目录数据与状态（父级共享，队列与规则目标不各拉一份）。 */
export interface CatalogData {
  groups: CatalogGroup[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  onRetry(): void;
}

/** 模型目录 picker props。 */
export interface CatalogPickerProps {
  t: TFn;
  /** 提示文案键（catalogHint / scheduleTargetsHint）。 */
  hintKey: string;
  catalog: CatalogData;
  selected: Record<string, boolean>;
  onToggle(provider: string, model: string): void;
  writable: boolean;
  busy: boolean;
  search: string;
  onSearch(text: string): void;
}

/** 配置卡：可用模型目录（provider 分组 + 搜索 + 勾选）。 */
export function CatalogPicker(props: CatalogPickerProps): React.ReactElement {
  const { t, catalog } = props;

  let body: React.ReactNode;
  if (catalog.status === 'loading' || catalog.status === 'idle') {
    body = <div style={S.hint}>{t('catalogLoading')}</div>;
  } else if (catalog.status === 'error') {
    body = (
      <div style={S.section}>
        <div style={S.hint}>{t('catalogError')}</div>
        <button type="button" style={S.btn} onClick={catalog.onRetry}>
          {t('catalogRetry')}
        </button>
      </div>
    );
  } else if (catalog.groups.length === 0) {
    body = <div style={S.hint}>{t('catalogEmpty')}</div>;
  } else {
    const visibleGroups = filteredCatalogGroups(catalog.groups, props.search);
    body = (
      <div style={S.section}>
        <input
          type="search"
          style={S.searchInput}
          placeholder={t('catalogSearch')}
          aria-label={t('searchAria')}
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
        />
        {visibleGroups.length === 0 ? (
          <div style={S.noMatch}>{t('catalogNoMatch')}</div>
        ) : (
          <div style={S.catalogScroll}>
            {visibleGroups.map((group) => (
              <div key={group.id} style={S.group}>
                <div style={S.groupTitle}>{group.id}</div>
                {group.models.map((model) => {
                  const key = group.id + '/' + model.id;
                  return (
                    <label key={key} style={S.check}>
                      <input
                        type="checkbox"
                        checked={props.selected[key] === true}
                        disabled={!props.writable || props.busy}
                        onChange={() => props.onToggle(group.id, model.id)}
                      />
                      <span>{model.name ?? model.id}</span>
                      <span style={S.hint}>{model.id}</span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={S.section}>
      <div style={S.label}>{t('catalog')}</div>
      <div style={S.hint}>{t(props.hintKey)}</div>
      {body}
    </div>
  );
}
