## Acceptance 方案

- **证据模式**：非视觉
- **最近用户可见行为**：Project Status continues to expose the same status summary.
- **保留行为**：相同输入继续产生相同 status summary、error boundary 和 cache invalidation behavior。
- **前后基线**：重构前保存 API fixture structured receipt；重构后对同一 fixture 重放并比较 structured receipt。
- **固定环境**：固定同一 Project fixture、persisted state、configuration 和 app version。
- **交互重放**：按相同顺序重放 API request 与 failure injection。
- **时序证据**：使用 structured logs 和 event sequence receipt。
- **Intentional differences / 非目标**：仅允许内部 module ownership 变化；不改变 public API。
