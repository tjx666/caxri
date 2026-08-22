<!-- prettier-ignore -->
```md
## Acceptance 方案

- **证据模式**：视觉
- **最近用户可见行为**：Status tree remains visible.
- **保留行为**：TBD
- **前后基线**：TBD
- **固定环境**：TBD
- **交互重放**：TBD
- **时序证据**：TBD
- **Intentional differences / 非目标**：TBD
```x
## Acceptance 方案

- **证据模式**：视觉
- **最近用户可见行为**：Status tree preserves its visible behavior.
- **保留行为**：保留 hierarchy、Refresh、focus 与 restart restoration。
- **前后基线**：重构前与重构后在相同 surfaces 和 states 捕获截图。
- **固定环境**：使用同一 Project/fixture、persisted state、theme、window size 和 viewport。
- **交互重放**：重构前后重放 click、double-click、keyboard、Refresh、Retry、navigation、restart 和 state restoration。
- **时序证据**：使用 GIF/video 记录 Refresh 与 restart 的 visible order。
- **Intentional differences / 非目标**：只允许内部 ownership 改变；其它 observable difference 均为 regression。
```
