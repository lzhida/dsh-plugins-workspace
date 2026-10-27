/**
 * 结构化 system-prompt 段落（纯函数）。
 *
 * 三个具名 section，order 取 PLUGIN 档（2950-2960，与宿主各 section 同档；
 * 同档内按 name 排序）。停用时仍注册并告知 agent「功能停用」，避免模型
 * 面对用户请求凭空造工具。
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

/** section 名（包名空间防撞）。 */
export const SECTION_WORKFLOW = 'dsh-patent:workflow';
export const SECTION_SECTIONS_GUIDE = 'dsh-patent:sections-guide';
export const SECTION_TOOLS = 'dsh-patent:tools';

/** order：交底书工作流 / 七部分要点 / 工具指引（PLUGIN 档内错开）。 */
export const ORDER_WORKFLOW = 2950;
export const ORDER_SECTIONS_GUIDE = 2955;
export const ORDER_TOOLS = 2960;

/** ① 交底书工作流。 */
export function workflowSection(enabled: boolean): PromptSection {
  return {
    name: SECTION_WORKFLOW,
    order: ORDER_WORKFLOW,
    text: enabled
      ? `Patent disclosure workflow (技术交底书) — help the INVENTOR deliver a disclosure their patent attorney (专利代理师) can understand.

1. Collect before drafting. Interview the inventor (ask_user_question) for: background art, the KEY technical problem (distinguish it from minor ones), the full solution at implementation level (structures, steps, parameters, data flow), alternatives, effects, protection points, and figures. Push for the adequacy bar: a same-field engineer must be able to implement the invention from part 三 alone.
2. Draft with disclosure_template_fill — it returns content markdown, the bundled template path, and a delivery guide.
3. Confirm the delivery form unless the user already said it: (a) bundled-template docx, (b) user-provided template docx, (c) plain markdown file they will fill themselves.
4. Validate with disclosure_check. Fix error-level issues yourself; surface warnings to the user — 〔…〕 placeholders are resolved by the user or via the plugin settings (disclosureDefaults), never silently dropped.
5. Deliver exactly per the delivery guide. python-docx fills keep the template format; for a user template, locate parts by their 一、…七、 titles and NEVER invent structure you did not find.
Reference: docs/patent-reference-notes.md next to the package collects real CNIPA publication conventions (background-art wording, claim-style phrasing).`
      : `The dsh-patent plugin is installed but disabled (enabled=false in Settings → Plugins → 专利交底). No disclosure tools or the patent-disclosure skill are available in this session; drafting guidance below still applies.`,
  };
}

/** ② 七部分撰写要点。 */
export function sectionsGuideSection(): PromptSection {
  return {
    name: SECTION_SECTIONS_GUIDE,
    order: ORDER_SECTIONS_GUIDE,
    text: `Disclosure structure (七部分) and what good content looks like:

- 一、背景技术: the state of the art BEFORE the improvement, in concrete terms (structures/circuits/processes). Cite prior publications as 申请公布号为CN…A的中国专利 when known. A brand-new product: describe the closest existing product/process instead.
- 二、背景技术的技术问题: name the single MOST critical problem first, then minor ones numbered. Defect vocabulary: 成本高/效率低/结构复杂/速度慢/体积大/能耗高.
- 三、本案的详细阐述 (THE core): full disclosure to implementation level — architecture, step-by-step flow with order, key parameters, data flow, and figure-reference tie-ins (图N). Anything the attorney cannot implement from this part alone is a disclosure defect.
- 四、可替代之处: substitutable parts/processes, omissible components. Optional but gold for claim drafting.
- 五、技术效果: mirror part 二's problems one-to-one (faster/smaller/cheaper/lower energy).
- 六、需要保护的要点: the technical key points. Claim-style phrasing welcome; validate any claim tree with patent_claims_check.
- 七、附图要求: list figures as 图1：…; mechanical products need AUTOCAD outline drawings (section/explosion views fine, numbered parts), electronic/electromechanical products need the main circuit diagram (block diagram first when dense).
All content in simplified Chinese; keep terminology consistent and use 「所述X」 only after X has been introduced.`,
  };
}

/** ③ 工具指引。 */
export function toolsSection(enabled: boolean): PromptSection {
  return {
    name: SECTION_TOOLS,
    order: ORDER_TOOLS,
    text: enabled
      ? `Patent tools (dsh-patent):

- disclosure_template_fill: build the disclosure content markdown + delivery guide. Pass header (caseName/applicationType/inventors/…) and sections (background/problems/solution/…). Company defaults come from plugin settings; user-provided values win. delivery: 'builtin-docx' | 'user-docx' | 'markdown'.
- disclosure_check: validate the disclosure markdown (seven-part completeness, placeholder leftovers, part-三 adequacy heuristic, problem priority structure). Run it before every delivery.
- patent_claims_check: validate a claim tree (numbering continuity, dependency direction, multi-dependent-on-multi-dependent, subject consistency). Use for part 六 when the inventor writes claim-style protection points, or when referencing published-claim structures.
Template path for docx filling comes from the tool result (bundled template lives inside the package; a user template path is whatever the user provides). Fill docx via bundled python + python-docx per docs/template-spec.md.`
      : `Patent tools are disabled in this session (dsh-patent enabled=false). Do not fabricate disclosure_template_fill / disclosure_check / patent_claims_check calls; if the user asks for disclosure work, tell them to enable the plugin in Settings → Plugins → 专利交底.`,
  };
}

/** 组装全部 section（纯函数，测试直连）。 */
export function buildSections(enabled: boolean): PromptSection[] {
  return [
    workflowSection(enabled),
    sectionsGuideSection(),
    toolsSection(enabled),
  ];
}
