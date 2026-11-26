import type { AgentChatTask } from '@caxri/protocol';

/**
 * Tracks how many background tasks each Chat's Agent still runs, the live `backgroundTaskCount` Terminal field. A turn
 * that ended with only background shells left settles (issue #4191), so without this a list would show a Session whose
 * shell still runs, and will wake the Agent again, as idle once its reply was read. A task list changes on every
 * streamed update, but the count only on a start or an end, so Clients are told only when the number moves. Memory
 * only: the provider process that runs the tasks ends with Server Core, and a provider exit marks its tasks stopped.
 */
export class ChatBackgroundTaskCounts {
    private readonly counts = new Map<string, number>();

    constructor(private readonly publish: (terminalId: string) => void) {}

    count(terminalId: string): number | undefined {
        return this.counts.get(terminalId);
    }

    record(terminalId: string, tasks: readonly AgentChatTask[] | undefined): void {
        const count =
            tasks?.filter((task) => task.status === 'running' && task.isBackground).length ?? 0;
        if (count === (this.counts.get(terminalId) ?? 0)) return;
        if (count === 0) this.counts.delete(terminalId);
        else this.counts.set(terminalId, count);
        this.publish(terminalId);
    }

    /**
     * Drops a Chat whose state was dropped; its tasks are no longer Caxri's to report.
     */
    forget(terminalId: string): void {
        if (this.counts.delete(terminalId)) this.publish(terminalId);
    }
}
