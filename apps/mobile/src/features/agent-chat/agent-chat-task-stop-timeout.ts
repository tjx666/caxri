/**
 * How long a background task may show `Stopping…` before the phone stops waiting for the Chat to report it ended.
 */
export const AGENT_CHAT_TASK_STOP_TIMEOUT_MS = 15_000;

/**
 * One timer per task being stopped. The stop request returning only means the provider was asked, so if the Chat never
 * reports the task ended, `onTimeout` fires once after {@link AGENT_CHAT_TASK_STOP_TIMEOUT_MS} and the caller re-enables
 * the button with a notice. `settle` (the task ended, or the stop request failed) and `dispose` (unmount) cancel timers
 * without firing.
 */
export class AgentChatTaskStopTimeouts {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly onTimeout: (taskId: string) => void,
        private readonly timeoutMs: number = AGENT_CHAT_TASK_STOP_TIMEOUT_MS,
    ) {}

    start(taskId: string): void {
        this.settle(taskId);
        this.timers.set(
            taskId,
            setTimeout(() => {
                this.timers.delete(taskId);
                this.onTimeout(taskId);
            }, this.timeoutMs),
        );
    }

    settle(taskId: string): void {
        const timer = this.timers.get(taskId);
        if (timer === undefined) return;
        clearTimeout(timer);
        this.timers.delete(taskId);
    }

    dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}
