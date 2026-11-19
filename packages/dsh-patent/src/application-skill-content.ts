/**
 * 内嵌方法论 skill：patent-application（申请文件生成侧）。
 *
 * 与 patent-disclosure（交底书撰写侧）、patent-draft-review（初稿审查侧）
 * 互补：前两者产出「交底书」与「审查意见」，这份产出**申请文件五书**
 * （扉页含摘要与摘要附图 / 权利要求书 / 说明书 / 附图）的撰写纪律。
 *
 * 事实依据：docs/patent-reference-notes.md（真实公布文本形态）。
 */

export const APPLICATION_SKILL_NAME = 'patent-application';

export const APPLICATION_SKILL_DESCRIPTION =
  'China patent application file drafting methodology (代理师申请文件生成侧): the five-part publication shape (front page carrying the abstract + abstract figure / claims / description / drawings), paragraph numbering discipline ([0001] continuous across sections), dual page numbering (per-part header + full-text footer), claim-layering discipline (independent claim carries the necessary features, dependent claims narrow, multi-dependent claims banned), and description sufficiency discipline (公开充分 + 可实施). Use when turning a 交底书 or attorney fragments into the skeleton of a Chinese patent application file, or when checking the formal shape of one; not for drafting the 交底书 itself (use patent-disclosure) and not for reviewing an attorney draft against source code (use patent-draft-review).';

export const APPLICATION_SKILL_CONTENT = `\
# 中国专利申请文件（五书）撰写方法论（代理师生成侧）

你站在代理师一侧，把交底书（或已写好的片段）组织成中国发明专利申请文件的
**五书**：扉页（含 (57) 摘要与摘要附图）、权利要求书、说明书、附图。

## 何时用 / 何时不用

- **用**：交底书已定稿、要出申请文件；代理师给了零散片段要拼骨架；检查既有申请
  文件的形式形态（段号、页码、章节齐备）。
- **不用**：写交底书本身（用 patent-disclosure skill）；拿初稿做源码级复核
  （用 patent-draft-review skill）；对比文件检索（用 patent_search 工具）。

## 五书的真实形态（先记这几条，否则排版即错）

1. **没有独立的「说明书摘要」页**。摘要只印在扉页的 (57) 栏，摘要附图紧随其后。
   顺序固定：扉页 → 权利要求书 → 说明书 → 说明书附图。
2. **段号** \`[0001]\` 半角方括号 + 4 位零填充，**跨小节连续到文末**，粒度跟随
   自然段；步骤行（如「（1）接收待处理的数据」）不单独起新段号。
3. **权项编号** \`1.\` 阿拉伯数字 + 点，与段落层级无关。
4. **页码双轨**：页眉「公布号 | 部分名 | N/M 页」——N/M 是**部分内**页码；页脚是
   **全文连续**页码。扉页 = 1 且自身不印页脚，权利要求书从 2 起接续。
5. **摘要**：单段、无段号，约 230-320 字。

## 权利要求书纪律

- **独权承载全部必要技术特征**：少了任一必要特征，独权就覆盖不住真正的创新点，
  也撑不住无效宣告的防线。
- **从属权只做收窄**，一层一层窄（权 2 窄权 1 的一部分，权 3 窄权 2），**权 3 不得
  引用权 1 再引权 2 之后又回头引权 1**。
- **多项从属权禁令**：一项从属权不得引用两项或以上另一权利要求。
- **类型引用句式**（设备权 / 介质权引用方法权，不是从属引用）：
  - 「实现根据权利要求 1 至 8 中任一项所述的方法」
  - 「实现权利要求 1 所述方法的步骤」
  - 「执行权利要求 1 所述的方法」
  这些是**类型引用**，不得当成从属权去解析引用关系，也不得报「引用格式错误」。
- 权项书一旦写定，**用 patent_claims_check 校验**（application_scaffold 内部复用
  同一套 checkClaims，诊断码与严重度一致，error 与 warning 两级都转发）。

## 说明书纪律

- 五章固定：技术领域 / 背景技术 / 发明内容（技术问题 + 有益效果 + 保护要点）/
  附图说明 / 具体实施方式。
- **公开充分**：说明书必须让同领域的技术人员**能够实施**，否则不是「不够细」而是
  「不可授权」——缺参数取值范围、缺流程分支条件、缺关键数据结构，都直接落进
  「不可实施」风险。
- **发明内容**用「第一方面 / 第二方面 / 第三方面」+「进一步地」+「本发明具备的
  有益效果是：」的套式；有益效果必须**与背景技术提出的问题一一对应**，否则效果链
  断裂。
- **附图说明**逐图独立成段：「图 N 是……的流程示意图」。
- **具体实施方式**给到可实施粒度：关键步骤给出参数、阈值、异常分支的处理。

## 摘要纪律

- 单段、无段号、不写「本发明」以外的开场白；约 230-320 字。
- 摘要**不是权项的复述**，写清「解决什么问题 + 怎么做 + 达到什么效果」。

## 工作纪律

- **工具只出骨架，不代拟实质内容**：application_scaffold 缺来源时留〔待补〕占位并
  记诊断；权利要求文字与说明书正文由代理师定稿，工具不臆造。
- **校验闭环**：application_scaffold 生成骨架 → patent_claims_check 校验权项书 →
  disclosure_check 复检重复度与术语 → 代理师定稿文字 → 落盘 docx（经 office
  skill / python，工具不落盘）。
- 引用对比文件时，只引**档位成立**的（申请日早于本申请申请日 = 可作有效对比文件）；
  档位判定用 patent_search 的机械日期比较结论，不是法律判断。
`;
