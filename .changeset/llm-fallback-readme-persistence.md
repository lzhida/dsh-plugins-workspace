---
'@zhidal/dsh-llm-fallback': patch
---

README 补充「配置存储与持久化」说明（纯文档，零行为变更）：

- **落点**：设置卡 / 设置面板保存的字段由宿主写进当前 profile 的补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的插件条目 `config`——per-profile 隔离（多 profile 互不影响）、重启保留
- **补丁层双角色**：同一个 `cordis.patch.yml` 既承载第三方插件条目注册（bundle 之外必经，须用 `- insert:` 块、不能平级 `- id:` 覆盖），也承载全部插件的 volatile 配置持久化（官方插件同落此层，以 `dsh-client-locale` 的语言偏好为例）；手改补丁层文件仅适用预置配置，日常一律走设置面板
- **`~/.dsh` 两类文件区分**：宿主托管配置（`profiles/<profile>/cordis.patch.yml`）vs 插件自有数据（`dsh-taskboard.json` 等 JSON、`storages/` 存储），并写明本插件不引入自有配置 / 数据文件的取舍（单一真相源、profile 隔离；运行状态持久化指向 roadmap 第三档）
- **故障排查新增一条**：profile 补丁层残留的 0.2.x 旧字段 `fallbackWhen` 无害——插件不识别、不迁移，也不影响行为，与「零成本升级」既有承诺一致

措辞按实测宿主 0.2.1-rc.2 的行为核对，不含未验证承诺；文档中不含任何真实密钥。
