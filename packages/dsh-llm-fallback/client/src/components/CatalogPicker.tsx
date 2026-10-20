/**
 * 模型目录 picker：搜索框 + 限高滚动列表 + 勾选。
 *
 * shadcn/ui 映射：搜索 → Input(type=search)，列表 → ScrollArea（限高
 * 280px，内部滚动），勾选行 → Checkbox；目录数据（groups/status/retry）
 * 由父级 useModelCatalog 提供并共享。
 *
 * @module dsh-llm-fallback/client/components/CatalogPicker
 */

import * as React from 'react';
import { filteredCatalogGroups } from '../lib/catalog.ts';
import type { CatalogGroup, TFn } from '../types.ts';
import { Button } from './ui/button.tsx';
import { Checkbox } from './ui/checkbox.tsx';
import { Input } from './ui/input.tsx';
import { ScrollArea } from './ui/scroll-area.tsx';

/** picker 的目录数据与状态（父级共享）。 */
export interface CatalogData {
  groups: CatalogGroup[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  onRetry(): void;
}

/** 模型目录 picker props。 */
export interface CatalogPickerProps {
  t: TFn;
  /** 提示文案键（catalogHint）。 */
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
    body = (
      <div className="text-xs text-muted-foreground">{t('catalogLoading')}</div>
    );
  } else if (catalog.status === 'error') {
    body = (
      <div className="flex flex-col items-start gap-2">
        <div className="text-xs text-muted-foreground">{t('catalogError')}</div>
        <Button variant="outline" size="sm" onClick={catalog.onRetry}>
          {t('catalogRetry')}
        </Button>
      </div>
    );
  } else if (catalog.groups.length === 0) {
    body = (
      <div className="text-xs text-muted-foreground">{t('catalogEmpty')}</div>
    );
  } else {
    const visibleGroups = filteredCatalogGroups(catalog.groups, props.search);
    body = (
      <div className="flex flex-col gap-2">
        <Input
          type="search"
          placeholder={t('catalogSearch')}
          aria-label={t('searchAria')}
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
        />
        {visibleGroups.length === 0 ? (
          <div className="px-0.5 py-2 text-xs text-muted-foreground">
            {t('catalogNoMatch')}
          </div>
        ) : (
          <ScrollArea className="max-h-[280px]">
            <div className="flex flex-col gap-1 p-2">
              {visibleGroups.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5">
                  <div className="mt-1.5 text-xs text-muted-foreground">
                    {group.id}
                  </div>
                  {group.models.map((model) => {
                    const key = group.id + '/' + model.id;
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] transition-colors duration-150 hover:bg-accent"
                      >
                        <Checkbox
                          checked={props.selected[key] === true}
                          disabled={!props.writable || props.busy}
                          onCheckedChange={() =>
                            props.onToggle(group.id, model.id)
                          }
                        />
                        <span className="truncate">
                          {model.name ?? model.id}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {model.id}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="text-[13px] font-semibold text-foreground">
        {t('catalog')}
      </div>
      <div className="text-xs text-muted-foreground">{t(props.hintKey)}</div>
      {body}
    </section>
  );
}
