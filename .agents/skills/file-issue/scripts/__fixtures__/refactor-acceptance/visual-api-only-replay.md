## Acceptance 方案

- **证据模式**：视觉
- **最近用户可见行为**：Status tree remains usable.
- **保留行为**：保留 hierarchy、Refresh 与 selection。
- **前后基线**：重构前保存 loading/success 截图；重构后复拍相同 surfaces。
- **固定环境**：使用同一 Project/fixture、persisted state、theme、window size 和 viewport。
- **交互重放**：只重放 API request 和 failure injection。
- **时序证据**：Refresh 与 restart 使用 video。
- **Intentional differences / 非目标**：无 intentional differences；其它差异阻断 Acceptance。
