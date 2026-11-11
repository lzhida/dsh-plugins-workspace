# Round 0 基线（循环审查 dsh-victauri 起点）

> 本文件是 ralph 循环的起点锚：第 1 轮 child 从这里开始（没有 round--1）。
> 日期：2026-11-05。仓库：E:\workspace\plugins\dsh-victauri（分支 dev，未 push）。

## 当前状态

- 批六 1/4~4/4 与批七 1/1 全部 in_review（清单全勾，提交 e7f02ab/a72c7cf、f9f3c34/221eacf、
  dbfec89/bb03c65、8f7bdb1/e129f0e、e6251d1/dc44987）；两张早期 in_review 卡
  t-mw1s7i0l-ygnwvv / t-mw1s8v85-l1gakh 复核结论已回写评论（不代移 done，等用户验收）。
- 六面差距清单：docs/audit/2026-11-05/gap-list.md（提交 a4729e1）——按严重度排序，每条带
  文件:行号 / 复现命令 / 上游出处。
- 批八已建卡：todo × 4（t-mw2etfbt-y4o7y4 renderJson S-3；t-mw2etsta-h2bf0n schema 收尾 P1/P2；
  t-mw2eu6r5-uew7ds 测试增强 T 组 + D-5；t-mw2euhui-e3bo22 文档同步 D 组 + E-2）+
  backlog × 2（t-mw2eut5k-6k1elc S-1/S-2 核心客户端语义；t-mw2evd2u-0dukch M/L 组评估类）。
  backlog 卡**未授权执行**（需用户批准），循环不得认领。

## 循环纪律（每轮）

1. 读上一轮 round-N.md（首轮读本文件）+ taskboard_list 看板现状。
2. 审查/执行：认领 todo 卡（todo→in_progress 带 ifVersion）→ 实现 → V1（typecheck/test/lint/
   format:check 全绿且用例覆盖改动点）→ V2（独立子代理审 diff；子代理不可用时 Lead 自查并在
   报告如实记录降级）→ 提交 dev（Conventional Commits 中文，不 push）→ execution_report +
   comment_add + checklist 勾选 + move in_review。
3. 每张卡完成后残余风险自评落盘 docs/audit/2026-11-05/risk-<cardId>.md（单独 commit）。
4. 本轮结论落盘 docs/audit/2026-11-05/round-N.md（N 从 1 起）。
5. taskboard_comment_add 回写父卡 t-mw21ydiw-mv754k（轮次结论 + 证据 + 剩余缺口）。

## 约束（不可违反）

- 不移任何卡到 done（用户专属动作）；backlog 卡不认领。
- 不 push / 不 force-push / 不在 main-master 提交；只动各卡描述列出的文件；同文件跨卡在后卡中叠加。
- 失败步骤最多重试 3 次并记录原因与修正；3 次仍失败 → 置 blocked/waitingForHuman 并写明原因。
- 终止条件：本轮无新增可执行缺口且无未处理 todo（提前收敛）或达到 20 轮上限——两者都要如实
  报告实际轮次与剩余缺口。
