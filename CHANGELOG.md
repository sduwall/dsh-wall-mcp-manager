# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.0 - 2026-09-19

### 破坏性变更
- **MCP 默认不启动（opt-in）**：`servers.<name>.enabled` 默认值由 `true` 改为 `false`。
  安装后不再自动拉起配置中的全部 MCP，需在设置界面勾选「启动」或在配置里显式
  `enabled: true` 才挂载。升级后原有服务如未显式声明 `enabled: true`，将保持停止状态
  （配置保留，不会丢失）。

### 新增
- 设置界面每个 MCP 增加「启动」复选框，勾选即挂载、取消即卸载，热生效。
- `package.json` 的 `dsh.compatibility` 增加 `verifiedDshVersions`（真机加载验证）：
  `0.1.2-alpha.2`（兼容下限）、`0.1.5-rc.2`（latest 稳定线）、`0.1.6-alpha.2`（alpha 线），
  并附 `verifiedRange` 说明 `>=0.1.2-alpha.2` 全部已发布版本经静态 API 核对一致。
- `scripts/verify-dsh-versions.mjs`：静态核对各已发布 DSH 版本的设置 API 签名，
  任一不一致即非零退出。
- `prepublishOnly` 发布前钩子：依次运行单元测试与 DSH 版本校验，任一失败即中止发布。
- GitHub Actions CI（Node 20/22 × ubuntu/windows）：push / PR 自动跑单测与版本校验。
- README 增加「权限、依赖与安全边界」一节。

### 修复
- 修复取消勾选后再次勾选时，界面在约数秒对账窗口内误显示「未挂载 / 未启动」的问题：
  服务状态改为依据当前配置实时推导，已启用但尚未挂载时显示「启动中」，仅真实挂载失败
  才标红「启动失败」。

## 0.1.0

- 初始版本：集中管理 MCP 服务配置，按实例配置指纹对账（增/改/删/不动），
  通过回环配置桥在设置界面展示挂载状态与工具契约。
- 支持旧版 DSH（≤ 0.1.1-rc.2，顶层 `installSettingsSection` 接口）。
  **0.2.0 起不再支持该版本线**，旧版 DSH 请锁定 `@sduwall/dsh-wall-mcp-manager@0.1.0`。
