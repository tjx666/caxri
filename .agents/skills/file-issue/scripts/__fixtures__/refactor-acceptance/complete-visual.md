## Acceptance 方案

- **证据模式**：视觉
- **最近用户可见行为**：Status tree preserves repository hierarchy, commands, focus, expansion, and restart restoration.
- **保留行为**：枚举 branch、issues、deployments、pull request、Refresh、Retry、navigation 和 state restoration 的既有行为。
- **前后基线**：重构前在 Status 的 loading、success、failure 与 restored states 截图并录制；重构后在相同 surfaces/states 复拍。
- **固定环境**：使用同一 Project/fixture、persisted state、theme、window size 和 viewport。
- **交互重放**：前后重放 click、double-click、keyboard、Refresh、Retry、navigation、restart 和 state restoration。
- **时序证据**：settled UI 使用截图；Refresh、Retry 与 restart 的事件顺序使用 video。
- **Intentional differences / 非目标**：只允许内部 Extension Host ownership 改变；其它可观察差异均阻断 Acceptance。
