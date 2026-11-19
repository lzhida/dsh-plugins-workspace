/**
 * 模型工具包装:disclosure_template_fill / disclosure_check /
 * patent_claims_check / claims_evidence_check / draft_review_check。
 *
 * 全部业务逻辑在纯函数层(disclosure.ts / disclosure-check.ts / claims.ts /
 * claims-evidence.ts / draft-review.ts),这里只做参数归一、公司默认值合并与
 * 输出渲染。无网络;唯一的文件读是 draft_review_check 读初稿 docx 的正文
 * (最小 zip 解析),docx 落盘仍由模型按交付指引经 office skill / python 完成。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { checkClaims } from './claims.ts';
import {
  checkClaimsEvidence,
  type EvidenceEntryInput,
} from './claims-evidence.ts';
import type { DisclosureDefaults } from './config.ts';
import {
  buildDisclosure,
  type DisclosureDelivery,
  type DisclosureHeader,
  type DisclosureSections,
} from './disclosure.ts';
import { checkDisclosure } from './disclosure-check.ts';
import { checkDraftReview, type ReviewFace } from './draft-review.ts';

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

/** 构建五个专利工具（getDefaults 每次执行现读，volatile 热生效）。 */
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
    defineTool({
      name: 'claims_evidence_check',
      description:
        'Reconcile patent claims against the disclosure text and the product source code (权项-说明书-源码三方对账). You read the code first: the report starts with a 待核对清单 (six dimensions — 常量 / 路径 / 枚举 / 函数名 / 层级序 / 分支数) extracted from the claim text, which tells you WHAT to look up; the tool never reads the source and never asserts a verdict for you. Then submit one evidence record per claim feature (claimNo / feature / docRef / sourceAnchors "file:line" / verdict / severity / carriers / suggestion); the tool enforces the evidence rule (a verdict without a file:line anchor is rejected), checks per-claim coverage, flags carrier-attribution conflicts between claims and the description, evaluates fallback-chain risks, and renders a claim-by-claim reconciliation matrix with 未覆盖 (uncovered) assets. Verdicts: supported / needs-rewrite / unsupported / uncovered. Use when auditing an attorney draft against the real implementation.',
      parameters: {
        claims: {
          type: 'string',
          required: true,
          description:
            'The claim set text; each claim starts with a "N." numbered line (same format as patent_claims_check).',
        },
        entries: {
          type: 'array',
          required: true,
          items: { type: 'object', additionalProperties: true },
          description:
            'Evidence records, one per claim feature: { claimNo (number|null), feature (string, required), docRef?, sourceAnchors (string[] like ["command.ts:1010-1020"], REQUIRED), verdict ("supported"|"needs-rewrite"|"unsupported"|"uncovered"), severity ("critical"|"high"|"medium"|"low"|"suggestion"), claimCarrier?, docCarrier?, suggestion? }.',
        },
        document: {
          type: 'string',
          description:
            'Optional: the disclosure markdown (or text extracted from a docx) so the tool can sanity-check the seven-part structure.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const report = value as {
            ok: boolean;
            markdown: string;
            stats: { claims: number; entries: number; rejected: number };
            issues: {
              code: string;
              severity: string;
              claimNo: number | null;
              message: string;
            }[];
          };
          const issues =
            report.issues.length > 0
              ? `Issues (${report.issues.length}):\n${report.issues
                  .map(
                    (i) =>
                      `- [${i.severity}] ${i.claimNo === null ? '全局' : `权${i.claimNo}`} ${i.code}: ${i.message}`,
                  )
                  .join('\n')}\n\n`
              : '';
          const stats = `stats: claims=${report.stats.claims} entries=${report.stats.entries} rejected=${report.stats.rejected} ok=${report.ok}\n\n`;
          return [
            { type: 'text', text: `${stats}${issues}${report.markdown}` },
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = (args ?? {}) as {
          claims?: unknown;
          entries?: unknown;
          document?: unknown;
        };
        return checkClaimsEvidence({
          claims: str(input.claims),
          entries: input.entries,
          document: str(input.document) || undefined,
        });
      },
    }),
    defineTool({
      name: 'draft_review_check',
      description:
        'Review an attorney patent draft (代理师初稿) and output a graded issue list (严重 / 高 / 中 / 低 / 建议), each with 位置 / 问题 / 依据 / 建议. Feed either a docx path (draftPath) or the text parts (abstract / claims / specification / figures). focus selects the review slice: "comply" (default: formal + comply), "formal" (形式规范: 权项结构、说明书五部分、摘要字数、附图标记、逐字重复、术语纪律、绝对化措辞), "prior-art" (只产出核查清单), "strategy" (从属链退守风险). Machine-checkable faces only: items needing human judgement (数值事实、图面语义、现有技术检索) are returned as a 核查清单 for you to verify — the tool never asserts them. Optional entries (from claims_evidence_check) let it report 权项特征无源码落点 and 从属链失实风险. Use when 复核代理师初稿; not for drafting a disclosure.',
      parameters: {
        draftPath: {
          type: 'string',
          description:
            'Optional: path to the draft .docx (text is extracted from word/document.xml).',
        },
        abstract: {
          type: 'string',
          description: 'Optional: the abstract text.',
        },
        claims: {
          type: 'string',
          description:
            'Optional: the claim set text (each claim starts with a "N." numbered line).',
        },
        specification: {
          type: 'string',
          description:
            'Optional: the specification text (技术领域 / 背景技术 / 发明内容 / 附图说明 / 具体实施方式).',
        },
        figures: {
          type: 'string',
          description: 'Optional: the figure description text.',
        },
        disclosure: {
          type: 'string',
          description:
            'Optional: the inventor disclosure text — it joins the text pool for the cross-source duplication check (摘要 / 权项书 / 说明书 / 附图 / 交底书 之间的逐字重复).',
        },
        disclosurePath: {
          type: 'string',
          description:
            'Optional: path to the inventor disclosure file (.md/.txt/.docx) — read in and joined into the same duplication-check text pool (used instead of disclosure when the text is not at hand).',
        },
        sourceRoot: {
          type: 'string',
          description:
            'Optional: source-code root directory. The tool only lists the files under it (so you know where to look); it never reads the code and never asserts a verdict — you read the code and submit evidence records via entries.',
        },
        entries: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Optional: the evidence records produced by claims_evidence_check, used to report 权项特征无源码落点 and 从属链失实污染风险.',
        },
        focus: {
          type: 'string',
          description:
            'Optional: "comply" (default) | "formal" | "prior-art" | "strategy".',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const report = value as {
            ok: boolean;
            focus: string;
            markdown: string;
            stats: { issues: number; bySeverity: Record<string, number> };
            issues: { code: string; severity: string; title: string }[];
            checklist: { code: string; face: string; title: string }[];
          };
          const issues =
            report.issues.length > 0
              ? `Issues (${report.issues.length}):\n${report.issues
                  .map((i) => `- [${i.severity}] ${i.title} (${i.code})`)
                  .join('\n')}\n\n`
              : '';
          const checklist =
            report.checklist.length > 0
              ? `待模型判断的核查清单 (${report.checklist.length}):\n${report.checklist
                  .map(
                    (item) => `- [${item.face}] ${item.title} (${item.code})`,
                  )
                  .join('\n')}\n\n`
              : '';
          return [
            {
              type: 'text',
              text: `focus=${report.focus} issues=${report.stats.issues} ok=${report.ok}\n\n${issues}${checklist}${report.markdown}`,
            },
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = (args ?? {}) as {
          draftPath?: unknown;
          abstract?: unknown;
          claims?: unknown;
          specification?: unknown;
          figures?: unknown;
          disclosure?: unknown;
          disclosurePath?: unknown;
          sourceRoot?: unknown;
          entries?: unknown;
          focus?: unknown;
        };
        const focus = str(input.focus);
        const face: ReviewFace =
          focus === 'formal' || focus === 'prior-art' || focus === 'strategy'
            ? focus
            : 'comply';
        return checkDraftReview({
          draftPath: str(input.draftPath) || undefined,
          abstract: str(input.abstract) || undefined,
          claims: str(input.claims) || undefined,
          specification: str(input.specification) || undefined,
          figures: str(input.figures) || undefined,
          disclosure: str(input.disclosure) || undefined,
          disclosurePath: str(input.disclosurePath) || undefined,
          sourceRoot: str(input.sourceRoot) || undefined,
          entries: Array.isArray(input.entries)
            ? (input.entries as EvidenceEntryInput[])
            : undefined,
          focus: face,
        });
      },
    }),
  ];
}
