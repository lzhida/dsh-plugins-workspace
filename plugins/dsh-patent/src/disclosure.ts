/**
 * 技术交底书内容层（纯函数，无 IO）。
 *
 * 目标角色：发明人向专利代理师交付「能看明白」的技术交底书。内容结构对齐
 * 内置模板（docs/template-spec.md）：头部字段 + 七个部分。本模块只产出内容
 * markdown 与交付指引；docx 落盘由模型按指引经 office skill / python-docx
 * 完成（内置模板 / 用户模板 / 纯 markdown 三条路径）。
 */

import { fileURLToPath } from 'node:url';

/** 交底书头部字段（公司信息未提供时保留占位）。 */
export type DisclosureHeader = {
  /** 专利申请案件名称（通常等于发明名称）。 */
  caseName?: string;
  /** 申请类型。 */
  applicationType?: '发明' | '实用新型';
  /** 内部案号。 */
  internalNo?: string;
  /** 申请人（公司/单位名称）。 */
  applicant?: string;
  /** 发明人（多人顿号分隔）。 */
  inventors?: string;
  /** 技术问题联系人。 */
  contactName?: string;
  /** 联系人电话。 */
  contactPhone?: string;
  /** 联系人邮箱。 */
  contactEmail?: string;
  /** 是否已有公开资料（期刊/论文/宣传册等）。 */
  published?: '是' | '否';
};

/** 交底书七个部分的填写内容（要点逐条成段）。 */
export type DisclosureSections = {
  /** 一、背景技术：改进前技术现状（每条一段）。 */
  background?: string[];
  /** 二、背景技术的技术问题。 */
  problems?: {
    /** 最主要、最关键的技术问题。 */
    main: string;
    /** 次要问题（可多个）。 */
    minor?: string[];
  };
  /** 三、本案的详细阐述（重点：公开充分到同领域技术人员能实施；每条一段）。 */
  solution?: string[];
  /** 四、可替代的部件/工艺/省略方案（可不填；每条一段）。 */
  alternatives?: string[];
  /** 五、技术效果（通常对应克服第二部分的问题；每条一段）。 */
  effects?: string[];
  /** 六、需要保护的要点（技术关键点；每条一段）。 */
  protectionPoints?: string[];
  /** 七、附图说明（图号：说明；每条一段）。 */
  figureNotes?: string[];
};

/** 交付路径。 */
export type DisclosureDelivery = 'builtin-docx' | 'user-docx' | 'markdown';

/** 模板填充输入。 */
export type DisclosureInput = {
  /** 交底书头部字段。 */
  header?: DisclosureHeader;
  /** 七个部分内容。 */
  sections?: DisclosureSections;
  /** 交付路径；缺省 'builtin-docx'。 */
  delivery?: DisclosureDelivery;
  /** 路径 B：用户提供的模板 docx 绝对路径。 */
  userTemplatePath?: string;
};

/** 内容诊断。 */
export type DisclosureIssue = {
  code: string;
  message: string;
};

/** 模板填充结果。 */
export type DisclosureResult = {
  /** 交底书内容 markdown（路径 C 直接作为交付文件内容）。 */
  markdown: string;
  /** 输入诊断（占位提示级）。 */
  issues: DisclosureIssue[];
  /** 内置模板绝对路径（三条路径通用参考；link: 安装下即源码目录内）。 */
  templatePath: string;
  /** 交付指引块（按 delivery 分支的操作说明，面向模型）。 */
  deliveryGuide: string;
};

/** 申请类型占位。 */
const APPTYPE_PLACEHOLDER = '〔发明/实用新型，二选一〕';

/** 内置模板绝对路径（assets 与 src 同包；link: 安装下指向源码目录）。 */
export function resolveBuiltinTemplatePath(): string {
  return fileURLToPath(
    new URL('../assets/disclosure-template.docx', import.meta.url),
  );
}

/** 空值占位（placeholder 为完整占位文本，提示用户自行修改）。 */
function orPlaceholder(value: string | undefined, placeholder: string): string {
  const text = value?.trim();
  return text && text.length > 0 ? text : placeholder;
}

/** 头部字段区 markdown（对齐模板头部行结构）。 */
function buildHeaderBlock(header: DisclosureHeader): string[] {
  const apptype = header.applicationType ?? APPTYPE_PLACEHOLDER;
  return [
    `- 专利申请案件名称：${orPlaceholder(header.caseName, '〔案件名称：请填写〕')}  申请类型：${apptype}  内部案号：${orPlaceholder(header.internalNo, '〔内部案号：请填写〕')}`,
    `- 申请人：${orPlaceholder(header.applicant, '〔申请人：请填写公司名称〕')}  发明人：${orPlaceholder(header.inventors, '〔发明人：请填写〕')}`,
    `- 技术问题联系人：${orPlaceholder(header.contactName, '〔联系人：请填写〕')}  联系人电话：${orPlaceholder(header.contactPhone, '〔联系人电话：请填写〕')}`,
    `- 联系人邮箱：${orPlaceholder(header.contactEmail, '〔联系人邮箱：请填写〕')}`,
    `- 已公开或即将公开发表与本技术相关的资料（期刊、论文、宣传册等）：${header.published ?? '〔是/否，二选一〕'}`,
  ];
}

/** 部分正文：要点成段；无输入时给出撰写提示占位。 */
function sectionBody(points: string[] | undefined, hint: string): string {
  if (points && points.length > 0) {
    return points
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .join('\n\n');
  }
  return `〔待填写：${hint}〕`;
}

/** 七个部分的 markdown。 */
function buildSectionsMarkdown(sections: DisclosureSections): string[] {
  const parts: string[] = [];

  parts.push('## 一、背景技术');
  parts.push(
    sectionBody(
      sections.background,
      '改进前技术现状的详细描述（可参考公开专利文本的背景技术写法；全新产品可介绍最接近的现有产品/工艺）',
    ),
  );
  parts.push('');

  parts.push('## 二、背景技术的技术问题');
  if (sections.problems?.main?.trim()) {
    parts.push(
      `**1.最主要、最关键的技术问题：** ${sections.problems.main.trim()}`,
    );
    const minor =
      sections.problems.minor?.filter((m) => m.trim().length > 0) ?? [];
    if (minor.length > 0) {
      parts.push(
        `**2.次要问题：** ${minor.map((m, i) => `(${i + 1}) ${m.trim()}`).join('；')}`,
      );
    }
  } else {
    parts.push(
      '〔待填写：1.最主要、最关键的技术问题；2.次要问题（如有多个依次列出）。指出现有方案的缺陷：成本高/效率低/结构复杂/速度慢/体积大/能耗高等〕',
    );
  }
  parts.push('');

  parts.push('## 三、本案的详细阐述');
  parts.push(
    sectionBody(
      sections.solution,
      '重点：完整公开技术手段与方法——同领域技术人员看过就能明白如何实施并解决上述问题（结构/步骤/参数/数据流，配合附图标记说明）',
    ),
  );
  parts.push('');

  parts.push('## 四、第三项的技术方案中有无可以替代的地方');
  parts.push(
    sectionBody(
      sections.alternatives,
      '可替代的部件/工艺、可省略的部件等（可不填，填了则更好，利于权利要求布局）',
    ),
  );
  parts.push('');

  parts.push('## 五、第三项的技术手段产生了什么技术效果');
  parts.push(
    sectionBody(
      sections.effects,
      '技术效果应与第二部分指出的技术问题一一对应（如速度更快/体积更小/能耗更低）',
    ),
  );
  parts.push('');

  parts.push('## 六、本案需要保护的要点');
  parts.push(
    sectionBody(
      sections.protectionPoints,
      '点明技术上的关键点/创新点（可用权利要求式表述：以 patent_claims_check 自查结构）',
    ),
  );
  parts.push('');

  parts.push('## 七、附图要求');
  parts.push(
    sectionBody(
      sections.figureNotes,
      '逐图说明（图1：…）；产品类需附图：机械产品 AUTOCAD 立体轮廓线图（可含剖面/爆炸图，零部件标序号），电子/机电产品提供主要电路图（复杂时分块或先框图）',
    ),
  );
  return parts;
}

/** 三种交付路径的指引块（面向模型执行）。 */
function buildDeliveryGuide(
  delivery: DisclosureDelivery,
  templatePath: string,
  userTemplatePath: string | undefined,
): string {
  if (delivery === 'markdown') {
    return [
      'Delivery: markdown file.',
      '- Write the markdown above verbatim to the workspace (e.g. `交底书-<案件名称>.md`) with the write tool.',
      '- Leave 〔…〕 placeholders as-is; they mark fields the user must fill.',
    ].join('\n');
  }
  if (delivery === 'user-docx') {
    return [
      'Delivery: fill the USER-provided template docx.',
      `- User template: ${userTemplatePath ?? '〔未提供 userTemplatePath——先向用户索要模板文件路径〕'}`,
      '- Load it with bundled python-docx (load_workspace_dependencies → python); walk paragraphs and tables to locate each part: match section titles 一、…七、 (or nearest semantic match).',
      '- Header fields: replace the value runs only (keep label runs and formatting). Content tables: clear the grey hint text in the target cell, then write the body (cell.add_paragraph for extra paragraphs, keep the first paragraph style).',
      '- Parts that cannot be located in the user template: keep them in a follow-up note so the user can paste them manually. Do not invent template structure.',
      '- Save to the workspace and tell the user the output path.',
    ].join('\n');
  }
  return [
    'Delivery: fill the bundled template docx (keeps the original format).',
    `- Template path: ${templatePath}`,
    '- Load with bundled python-docx (load_workspace_dependencies → python). Header: replace value runs per docs/template-spec.md (title row, case-name row, applicant/inventor row, contact rows, published row).',
    '- Parts 一~六: doc.tables[0..5], rows[0].cells[0] — clear the grey hint text and write the body (add_paragraph keeps first style). Part 七 has no table.',
    '- Company info: use disclosureDefaults from plugin settings when the user did not provide values; keep 〔…〕 placeholders otherwise and remind the user.',
    '- Save to the workspace and tell the user the output path. Full spec: docs/template-spec.md next to this package.',
  ].join('\n');
}

/** 主入口：生成交底书内容 markdown + 交付指引。 */
export function buildDisclosure(input: DisclosureInput): DisclosureResult {
  const issues: DisclosureIssue[] = [];
  const header: DisclosureHeader = input.header ?? {};
  const sections: DisclosureSections = input.sections ?? {};
  const delivery: DisclosureDelivery = input.delivery ?? 'builtin-docx';

  if (delivery === 'user-docx' && !input.userTemplatePath?.trim()) {
    issues.push({
      code: 'DISCLOSURE_USER_TEMPLATE_MISSING',
      message:
        '交付路径为用户模板，但未提供 userTemplatePath；请向用户索要模板 docx 路径，或改用内置模板/markdown 交付。',
    });
  }

  const hasContent = Object.values(sections).some((v) =>
    Array.isArray(v)
      ? v.some((s) => s.trim().length > 0)
      : typeof v === 'object' && v !== null
        ? Object.values(v).some((s) => String(s).trim().length > 0)
        : Boolean(v),
  );
  if (!hasContent) {
    issues.push({
      code: 'DISCLOSURE_CONTENT_EMPTY',
      message:
        '七个部分均为空：已产出骨架占位，请向发明人逐部分收集技术要点后重新生成。',
    });
  }

  const templatePath = resolveBuiltinTemplatePath();
  const markdown = [
    '# 专利技术交底书',
    '',
    ...buildHeaderBlock(header),
    '',
    ...buildSectionsMarkdown(sections),
    '',
  ].join('\n');

  return {
    markdown,
    issues,
    templatePath,
    deliveryGuide: buildDeliveryGuide(
      delivery,
      templatePath,
      input.userTemplatePath,
    ),
  };
}
