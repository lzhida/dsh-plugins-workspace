/**
 * 模型工具包装：disclosure_template_fill / disclosure_check / patent_claims_check。
 *
 * 全部业务逻辑在纯函数层（disclosure.ts / disclosure-check.ts / claims.ts），
 * 这里只做参数归一、公司默认值合并与输出渲染。无网络、无文件 IO——docx
 * 落盘由模型按交付指引经 office skill / python 完成。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { checkClaims } from './claims.ts';
import type { DisclosureDefaults } from './config.ts';
import {
  buildDisclosure,
  type DisclosureDelivery,
  type DisclosureHeader,
  type DisclosureSections,
} from './disclosure.ts';
import { checkDisclosure } from './disclosure-check.ts';

/** 从自由对象里取非空字符串。 */
function str(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text;
}

/**
 * 合并头部字段：用户显式值 > 插件设置默认值 > undefined（占位）。
 * applicationType/published 只接受合法枚举值。
 */
export function mergeHeader(
  input: unknown,
  defaults: DisclosureDefaults,
): DisclosureHeader {
  const h = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string, fallback: string): string | undefined => {
    const own = str(h[key]);
    if (own.length > 0) return own;
    return fallback.length > 0 ? fallback : undefined;
  };
  return {
    caseName: pick('caseName', ''),
    applicationType:
      h.applicationType === '发明' || h.applicationType === '实用新型'
        ? h.applicationType
        : undefined,
    internalNo: pick('internalNo', defaults.internalNo),
    applicant: pick('applicant', defaults.applicant),
    inventors: pick('inventors', ''),
    contactName: pick('contactName', defaults.contactName),
    contactPhone: pick('contactPhone', defaults.contactPhone),
    contactEmail: pick('contactEmail', defaults.contactEmail),
    published:
      h.published === '是' || h.published === '否' ? h.published : undefined,
  };
}

/** 收敛交付路径枚举。 */
function pickDelivery(value: unknown): DisclosureDelivery {
  return value === 'user-docx' || value === 'markdown' ? value : 'builtin-docx';
}

/** 构建三个专利工具（getDefaults 每次执行现读，volatile 热生效）。 */
export function buildPatentTools(getDefaults: () => DisclosureDefaults) {
  return [
    defineTool({
      name: 'disclosure_template_fill',
      description:
        "Build a patent disclosure (技术交底书) content markdown from the inventor's points: header fields + seven required parts (background / key problem / full solution / alternatives / effects / protection points / figures). Returns the content markdown, the bundled template path, and a delivery guide (bundled-template docx / user-template docx / plain markdown). Company defaults come from plugin settings; explicit arguments win.",
      parameters: {
        header: {
          type: 'object',
          additionalProperties: true,
          description:
            'Header fields (all optional): caseName, applicationType ("发明"|"实用新型"), internalNo, applicant, inventors, contactName, contactPhone, contactEmail, published ("是"|"否").',
        },
        sections: {
          type: 'object',
          additionalProperties: true,
          description:
            'Seven parts (all optional): background: string[], problems: {main, minor?: string[]}, solution: string[], alternatives: string[], effects: string[], protectionPoints: string[], figureNotes: string[].',
        },
        delivery: {
          type: 'string',
          enum: ['builtin-docx', 'user-docx', 'markdown'],
          description: 'Delivery path; default builtin-docx.',
        },
        userTemplatePath: {
          type: 'string',
          description:
            'Absolute path to the user-provided template docx (delivery=user-docx only).',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const result = value as {
            markdown: string;
            deliveryGuide: string;
            issues: { code: string; message: string }[];
          };
          const issues =
            result.issues.length > 0
              ? `Issues:\n${result.issues.map((i) => `- [${i.code}] ${i.message}`).join('\n')}\n\n`
              : '';
          return [
            {
              type: 'text',
              text: `${issues}${result.markdown}\n\n--- DELIVERY GUIDE ---\n${result.deliveryGuide}`,
            },
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = (args ?? {}) as {
          header?: unknown;
          sections?: unknown;
          delivery?: unknown;
          userTemplatePath?: unknown;
        };
        return buildDisclosure({
          header: mergeHeader(input.header, getDefaults()),
          sections: (input.sections ?? {}) as DisclosureSections,
          delivery: pickDelivery(input.delivery),
          userTemplatePath: str(input.userTemplatePath) || undefined,
        });
      },
    }),
    defineTool({
      name: 'disclosure_check',
      description:
        'Validate a patent disclosure markdown (the output of disclosure_template_fill, or a pasted/filled document): seven-part completeness, header placeholder leftovers, part-三 disclosure-adequacy heuristic, problem priority structure. Run before every delivery; fix error-level issues yourself and surface warnings to the user.',
      parameters: {
        document: {
          type: 'string',
          required: true,
          description: 'The disclosure markdown to check.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const report = value as {
            issues: {
              section: string;
              severity: string;
              code: string;
              message: string;
            }[];
            ok: boolean;
            stats: { solutionChars: number; sectionCount: number };
          };
          const lines = [
            `ok=${report.ok} sections=${report.stats.sectionCount}/7 solutionChars=${report.stats.solutionChars}`,
            ...report.issues.map(
              (i) => `- [${i.severity}] (${i.section}) ${i.code}: ${i.message}`,
            ),
          ];
          return [{ type: 'text', text: lines.join('\n') || 'no issues' }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = (args ?? {}) as { document?: unknown };
        return checkDisclosure(str(input.document));
      },
    }),
    defineTool({
      name: 'patent_claims_check',
      description:
        'Validate a Chinese patent claim set structure: numbering continuity, duplicate numbers, dependency direction (no forward/missing/self references), multi-dependent-on-multi-dependent prohibition, subject-name consistency between dependent and referenced claims, and 「其特征在于」 presence in independent claims. Use for claim-style protection points or when referencing published claim structures.',
      parameters: {
        claims: {
          type: 'string',
          required: true,
          description:
            'The claim set text; each claim starts with a "N." numbered line.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const report = value as {
            issues: {
              claim: number | null;
              severity: string;
              code: string;
              message: string;
            }[];
            ok: boolean;
            stats: {
              total: number;
              independent: number;
              dependent: number;
              multiDependent: number;
            };
          };
          const lines = [
            `ok=${report.ok} total=${report.stats.total} independent=${report.stats.independent} dependent=${report.stats.dependent} multiDependent=${report.stats.multiDependent}`,
            ...report.issues.map(
              (i) =>
                `- [${i.severity}] ${i.claim === null ? '全局' : `权利要求${i.claim}`} ${i.code}: ${i.message}`,
            ),
          ];
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = (args ?? {}) as { claims?: unknown };
        return checkClaims(str(input.claims));
      },
    }),
  ];
}
