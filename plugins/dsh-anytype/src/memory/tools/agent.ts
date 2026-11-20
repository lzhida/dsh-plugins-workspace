/**
 * agent 组：把「语义判断」外包给外部 agent 的工具接口。
 *
 * - `memory_candidates`：零 LLM 切块 + 同 scope 近邻（写前读的另一半）；
 * - `memory_set_embedding`：把**外部 agent 算好的向量**写进记忆对象
 *   （插件只搬运不算——Anytype 桌面端 API 没有向量能力，插件也不跑模型）；
 * - `memory_suggest_links`：近邻候选，**只建议不写**。
 *
 * 这三个工具是「插件不跑模型」与「插件仍然好用」之间的桥：抽取、去重
 * 裁决、合并、重排都在 agent 侧，插件只提供确定性的原料与原语。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { chunkText, queryTerms } from '../chunk.ts';
import { encodeVector, validateVector } from '../embedding.ts';
import { MEMORY_KINDS } from '../schema.ts';
import {
  andFilter,
  excerpt,
  inFilter,
  numberOf,
  outputSpec,
  propertyKey,
  resolveSpaceId,
  SCOPE_PARAM,
  textOf,
  type MemoryToolDeps,
} from './shared.ts';

/** 构建 agent 组工具。 */
export function buildAgentTools(deps: MemoryToolDeps) {
  return [
    defineTool({
      name: 'memory_candidates',
      description:
        'Prepare material for memory extraction, without any model call: split a text (or a source object) into candidate chunks and list nearby stored memories. Use it before memory_write so you can dedupe or supersede instead of creating duplicates. The chunks are raw material — YOU decide what becomes a memory.',
      parameters: {
        text: {
          type: 'string',
          description:
            'Raw text to split into candidate chunks (e.g. a conversation excerpt).',
        },
        source_object_id: {
          type: 'string',
          description:
            'Read the text from this Anytype object instead of passing text.',
        },
        space_id: SCOPE_PARAM,
        chunk_size: {
          type: 'integer',
          description: 'Target chunk length in characters (default 400).',
        },
        top_k: {
          type: 'integer',
          description: 'How many nearby memories to return (default 10).',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        let text = typeof args.text === 'string' ? args.text : '';
        let sourceObjectId: string | undefined;
        if (text.length === 0 && args.source_object_id !== undefined) {
          sourceObjectId = String(args.source_object_id);
          const doc = await deps.store.getObject(
            spaceId,
            sourceObjectId,
            exec.signal,
            'md',
          );
          text = String(doc.markdown ?? '');
        }
        const chunks = chunkText(text, {
          targetChars:
            typeof args.chunk_size === 'number' && args.chunk_size > 0
              ? args.chunk_size
              : undefined,
        });
        const terms = queryTerms(text);
        const topK =
          typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : 10;

        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const kindKey = propertyKey(keys, 'kind');
        const statusKey = propertyKey(keys, 'status');
        const confidenceKey = propertyKey(keys, 'confidence');

        const neighbours = await deps.store.search({
          spaceId,
          query: terms.slice(0, 4).join(' '),
          filter: andFilter([
            inFilter(kindKey, [...MEMORY_KINDS]),
            inFilter(statusKey, ['approved', 'draft', 'disputed']),
          ]),
          fields: [kindKey, statusKey, 'name', 'confidence', 'created_at'],
          limit: topK,
          signal: exec.signal,
        });

        return {
          chunks,
          neighbours: neighbours.rows.map((row) => ({
            object_id: row.id,
            name: row.name,
            kind: textOf(row.properties?.[kindKey]),
            status: textOf(row.properties?.[statusKey]),
            confidence: numberOf(row.properties?.[confidenceKey]) ?? null,
            excerpt: excerpt(row.name ?? ''),
          })),
          source_object_id: sourceObjectId ?? null,
          hints: {
            next: 'Distill the chunks into atomic memories with memory_write; pass supersedes[] for facts that replace older ones.',
          },
        };
      },
    }),

    defineTool({
      name: 'memory_set_embedding',
      description:
        'Store an embedding YOU computed on a memory object (base64 float32 in the embedding property, plus embedding_model and embedding_dim). The plugin never computes embeddings and never calls a model. Mixing vector spaces is forbidden: storing a vector from a different model than the one already used is refused. After storing, pass the same embedding_model and the query vector to memory_recall to enable the vector arm.',
      parameters: {
        object_id: {
          type: 'string',
          required: true,
          description: 'Memory object id.',
        },
        vector: {
          type: 'array',
          required: true,
          description: 'The embedding vector (numbers).',
          items: { type: 'number' },
        },
        embedding_model: {
          type: 'string',
          description:
            'Identifier of the embedding model (e.g. "bge-m3"). Required to keep vector spaces separate.',
        },
        space_id: SCOPE_PARAM,
        dry_run: {
          type: 'boolean',
          description: 'true = validate without writing.',
        },
      },
      output: outputSpec(),
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const objectId = String(args.object_id);
        const validation = validateVector(args.vector);
        if (!validation.ok) {
          throw new Error(`invalid vector: ${validation.error}`);
        }
        const model = String(args.embedding_model ?? '');
        if (model.length === 0) {
          throw new Error(
            'embedding_model is required — vectors from different models must never be mixed.',
          );
        }
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const embeddingKey = propertyKey(keys, 'embedding');
        const modelKey = propertyKey(keys, 'embeddingModel');
        const dimKey = propertyKey(keys, 'embeddingDim');

        const { doc, etag } = await deps.store.getObjectWithEtag(
          spaceId,
          objectId,
          exec.signal,
        );
        const properties = (doc.properties ?? {}) as Record<string, unknown>;
        const existingModel = textOf(properties[modelKey]);
        const existingDim = numberOf(properties[dimKey]);
        if (existingModel.length > 0 && existingModel !== model) {
          throw new Error(
            `this memory already stores an embedding from "${existingModel}" — refusing to mix vector spaces. Re-embed the whole space with one model first.`,
          );
        }
        if (
          existingDim !== undefined &&
          existingDim !== validation.dim &&
          existingDim > 0
        ) {
          throw new Error(
            `this memory already stores a ${existingDim}-dimensional embedding — refusing to overwrite it with ${validation.dim} dimensions.`,
          );
        }

        const encoded = encodeVector(args.vector as number[]);
        await deps.store.setProperties(
          spaceId,
          objectId,
          {
            [embeddingKey]: encoded,
            [modelKey]: model,
            [dimKey]: validation.dim,
          },
          etag,
          args.dry_run === true,
          exec.signal,
        );
        return {
          object_id: objectId,
          stored: args.dry_run === true ? false : true,
          dim: validation.dim,
          model,
          bytes: encoded.length,
        };
      },
    }),

    defineTool({
      name: 'memory_suggest_links',
      description:
        'Suggest edges between memories based on shared tags and lexical proximity. It NEVER writes — it returns candidates so you can judge and then call memory_link with a controlled edge type (relates_to | derived_from | contradicts | supersedes | mentions).',
      parameters: {
        space_id: SCOPE_PARAM,
        object_id: {
          type: 'string',
          description:
            'Anchor memory object id. Omit to suggest links across the whole space.',
        },
        top_k: {
          type: 'integer',
          description: 'How many candidates to return (default 10).',
        },
      },
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const spaceId = await resolveSpaceId(deps, args.space_id);
        const keys = await deps.store.resolveKeys(spaceId, exec.signal);
        const key = (semantic: string): string => propertyKey(keys, semantic);
        const topK =
          typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : 10;

        let anchorName = '';
        let anchorTags: string[] = [];
        let anchorId = '';
        if (args.object_id !== undefined) {
          anchorId = String(args.object_id);
          const { doc } = await deps.store.getObjectWithEtag(
            spaceId,
            anchorId,
            exec.signal,
          );
          const properties = (doc.properties ?? {}) as Record<string, unknown>;
          anchorName = String(doc.name ?? '');
          const tags = properties[key('tag')];
          anchorTags = Array.isArray(tags)
            ? tags.map((t) => String(t))
            : typeof tags === 'string'
              ? [tags]
              : [];
        }

        const result = await deps.store.search({
          spaceId,
          query:
            anchorName.length > 0 ? queryTerms(anchorName, 4).join(' ') : '',
          fields: [
            key('kind'),
            key('status'),
            'name',
            key('tag'),
            key('source'),
          ],
          limit: topK * 3,
          signal: exec.signal,
        });

        const suggestions = result.rows
          .filter((row) => row.id !== anchorId)
          .map((row) => {
            const props = row.properties ?? {};
            const tags = props[key('tag')];
            const rowTags = Array.isArray(tags)
              ? tags.map((t) => String(t))
              : typeof tags === 'string'
                ? [tags]
                : [];
            const shared = rowTags.filter((t) => anchorTags.includes(t));
            return {
              object_id: row.id,
              name: row.name,
              kind: textOf(props[key('kind')]),
              status: textOf(props[key('status')]),
              shared_tags: shared,
              reason:
                shared.length > 0
                  ? `shares ${shared.length} tag(s) with the anchor`
                  : 'lexically close to the anchor',
            };
          })
          .slice(0, topK);

        return {
          anchor: anchorId || null,
          suggestions,
          next: 'Judge each suggestion, then create the edge with memory_link.',
        };
      },
    }),
  ];
}
