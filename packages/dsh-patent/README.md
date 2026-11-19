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
  充分度启发式（同领域技术人员可实施标准，全占位骨架同样提示）、技术问题主次结构、
  残留占位扫描；初稿高发问题检测：同源文本重复度（全文两段公共后缀 ≥100 字、
  第三↔第五部分成对复用段落 ≥40 字）与「所述X」术语互为包含的一词多义信号。
- **`patent_claims_check`**：权利要求结构校验（编号连续、从属引用在先、多项从属不
  嵌套、主题一致、其特征在于），服务「六、需要保护要点」的权利要求式表述；介质/
  设备权对方法权利要求的类型引用（「执行/实现权利要求 N 所述的方法」）按公布文本
  变体识别，不误判为从属引用。

## 内嵌方法论 skill

插件按需注入两份方法论 skill（`source: 'bundled'`，模型可在会话中自行加载，
卸载插件即注销）：

- **`patent-disclosure`（撰写侧）**：技术交底书撰写方法论——七部分结构、公开充分
  标准、CNIPA 措辞参考与 docx 交付路径。触发场景：起草、补写或交付交底书。
- **`patent-draft-review`（审查侧，0.2.0）**：代理师初稿复核方法论——24 视角交叉
  审查拓扑（合规 A10 / 源码对照 B7 / 交底书对照 C3 / 战略 D4）、两条定权规则、
  收敛纪律（断言必须挂源码 `文件:行号` 或文档条目）、纠错纪律（预判被证伪即以
  代码事实撤回）与轻量档/全量档裁剪规则。触发场景：复核代理师初稿、权项-源码
  对账；不适用于撰写交底书或纯形式校验。

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
pnpm --filter @zhidal/dsh-patent build   # esbuild → dist/index.js（实体安装/发布必需）
```

发布形态为构建式（`main` 指 `dist/index.js`，源码入口无法实体安装）：改动源码后
先 `build` 再重启实例；`pnpm pack` / `prepare` / `prepack` 自动构建。

e2e（真实 dsh 实例四步流程）见仓库 `.agents/skills/dsh-plugin-dev/SKILL.md` §5。

## 参考

- 内置模板为本仓库从零构建的通用交底书模板（无特定组织信息，可公开发布）；
- 权利要求句式校验按真实公布文本的宽容变体设计（见 docs/patent-reference-notes.md）。
