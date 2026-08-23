## Acceptance 方案

- **证据模式**：非视觉
- **最近用户可见行为**：Project Status 在相同 Session 中继续返回相同 hierarchy、state 与 refresh behavior。
- **保留行为**：相同输入继续产生相同 status summary、error boundary 和 cache invalidation behavior。
- **前后基线**：重构前保存 API fixture 的 structured receipt；重构后对同一 fixture 重放并比较 structured receipt。
- **固定环境**：固定 Project fixture、persisted state、configuration 和 app version；theme、window size 与 viewport 不适用于该非视觉边界。
- **交互重放**：按相同顺序重放 API request、cache hit、forced refresh 与 failure injection。
- **时序证据**：用 structured logs 和 event sequence receipt 比较 refresh/invalidation 顺序，不伪造 UI 截图。
- **Intentional differences / 非目标**：允许内部 module ownership 变化；不改变 public API、用户可见状态或 error semantics。
