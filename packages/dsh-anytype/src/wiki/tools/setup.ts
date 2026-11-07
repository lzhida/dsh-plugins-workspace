/**
 * setup 组：wiki_setup——幂等建立笔记工作环境。
 *
 * 做三件事（全部幂等，重复执行零新建）：
 * 1. 解析/创建笔记空间（按 `spaceId` 钉住，或按 `spaceName` 找/建）；
 * 2. 建 `wiki_note` 类型并带上完整字段表（basic 布局——note 布局会吞标题）；
 * 3. 把缺失属性补挂到类型的字段表（**必须**——不在字段表里的属性虽然会被
 *    存储，但按类型过滤时该键被拒绝）。
 */

import { DRY_RUN_PARAM } from '../../core/index.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { outputSpec, type WikiToolDeps } from './shared.ts';

/** 构建 setup 组工具。 */
export function buildSetupTools(deps: WikiToolDeps) {
  return [
    defineTool({
      name: 'wiki_setup',
      description:
        'Prepare the Anytype space used as the AI note workspace: resolve or create the space, create the "wiki_note" object type with its full field list (status / source / timestamps / review audit fields), and attach any missing properties to the type. Idempotent — running it twice creates nothing new. Run it once before wiki_write; afterwards it is only needed after the schema changes.',
      parameters: {
        space_name: {
          type: 'string',
          description:
            'Name of the wiki space (default: the configured spaceName). Created when missing and create_space=true.',
        },
        space_id: {
          type: 'string',
          description:
            'Pin an existing space id (short reference like 64xiwe or full id). Overrides space_name resolution.',
        },
        create_space: {
          type: 'boolean',
          description:
            'true = create the space when it does not exist (default true). false = fail with an actionable error instead.',
        },
        dry_run: DRY_RUN_PARAM,
      },
      output: outputSpec(),
      async execute(args) {
        const cfg = deps.config();
        const spaceName =
          String(args.space_name ?? cfg.spaceName).trim() || cfg.spaceName;
        const spaceIdArg = String(args.space_id ?? cfg.spaceId).trim();
        const createSpace = args.create_space !== false;
        const dryRun = args.dry_run === true;

        const { spaceId, created } = await deps.store.resolveSpace(
          spaceIdArg,
          spaceName,
          createSpace,
        );
        const result = await deps.store.setupSchema(spaceId, dryRun);
        deps.store.invalidateKeys(spaceId);

        return {
          space_id: spaceId,
          space_created: created,
          created: [...result.createdTypes, ...result.addedProperties],
          skipped: result.existingTypes,
          schema_version: 'v1',
          keys: result.keys,
          warnings: result.warnings,
        };
      },
    }),
  ];
}
