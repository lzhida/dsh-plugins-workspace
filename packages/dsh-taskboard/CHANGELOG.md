# @lzhida/dsh-taskboard

## 0.8.8

### Patch Changes

- 4f65044: 重新同步上游 cloader/dsh-taskboard v0.8.7（commit 31e135a）真实源码，整体替换此前 0.1.0 的契约级教学复刻；包版本起点对齐上游 0.8.7。功能面与上游一致（10 个 taskboard_* 工具、SSE 实时看板、host 侧 cron/一次性定时执行、git worktree 隔离与多仓库镜像、外部会话同步、任务模板、图片附件），并完成 monorepo 一致性重构（不改功能）：TS 源码入口（仅 link: 安装）、客户端预构建产物提交于 client/index.js、宿主半区构造器参数属性转显式字段（Node type-stripping 兼容）、apply 打印装载日志、@deepseek-ai/* 全部 devDependencies type-only（类型对齐 0.2.0-rc.2）、上游 vitest 测试移植为 src/*.test.ts、Apache-2.0 LICENSE 与 README 署名。
