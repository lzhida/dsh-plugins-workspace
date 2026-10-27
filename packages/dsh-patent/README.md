# @zhidal/dsh-patent

「**专利交底**」预设 bundle：协助**发明人**撰写技术交底书（中国专利），交付一份专利
代理师能看明白的交底书。安装后 Web 新建会话的预设选择器出现「专利交底」。

## 组成（一个包，两个插件行）

| 行              | 入口                            | 内容                                                                               |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `dsh-patent`    | `./src/index.ts`                | 三个模型工具 + 三个结构化 prompt section + 内嵌方法论 skill（`patent-disclosure`） |
| `preset-patent` | `@deepseek-ai/dsh-agent-preset` | 「专利交底」预设：发明人助手 persona + 检索/文件/office skill 链 + 压缩组          |

## 模型工具

- **`disclosure_template_fill`**：按交底要点产出内容 markdown（头部字段 + 七部分），
  返回内置模板绝对路径与交付指引。`delivery` 三选一：
  - `builtin-docx`（默认）：内置去公司化模板（`assets/disclosure-template.docx`），
    经捆绑 python-docx 填充，保留模板格式；
  - `user-docx`：用户提供模板 → 按一、…七、标题定位填充，找不到的部分提醒用户手工补位；
  - `markdown`：直接写 .md 文件，用户自行填写。
- **`disclosure_check`**：交底书合规检查——七部分齐全、头部占位提醒、第三部分公开
  充分度启发式（同领域技术人员可实施标准）、技术问题主次结构、残留占位扫描。
- **`patent_claims_check`**：权利要求结构校验（编号连续、从属引用在先、多项从属不
  嵌套、主题一致、其特征在于），服务「六、需要保护要点」的权利要求式表述。

## 公司信息

插件设置（`disclosureDefaults`）存一次默认值（申请人/联系人/电话/邮箱/内部案号）；
用户显式提供的值优先；两者皆无时产出占位「〔…：请填写〕」并提醒用户自行修改。

## 文档

- `docs/template-spec.md`：内置模板结构规格与 python-docx 填充规则
- `docs/patent-reference-notes.md`：真实 CNIPA 公布文本撰写参考语料

## 开发

```sh
pnpm --filter @zhidal/dsh-patent typecheck
pnpm vitest run packages/dsh-patent
```

e2e（真实 dsh 实例四步流程）见仓库 `.agents/skills/dsh-plugin-dev/SKILL.md` §5。

## 参考

- 交底书模板来自用户提供的公司模板，已去公司化（申请人占位）；
- 权利要求句式校验按真实公布文本的宽容变体设计（见 docs/patent-reference-notes.md）。
