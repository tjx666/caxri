import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { MAX_AGENT_CHAT_OUTPUT_LENGTH } from '@caxri/protocol';

import { isRecord, tail } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';

/**
 * How often a running background shell's output tail is re-read while it runs.
 */
const OUTPUT_POLL_MS = 1_000;

/**
 * Claude Code's `get_task_output` control request. The SDK implements it on `Query` without declaring it, so it is
 * reached through a runtime check rather than a type.
 */
type TaskOutputReader = (taskId: string) => Promise<unknown>;

/**
 * Mirrors the output tail of a Claude Code Chat's background shells into their task tabs. It polls while any listed
 * shell runs and stops itself once none does; a finished shell gets one final read.
 */
export class ClaudeShellOutput {
    private readonly outputs = new Map<string, string>();

    private pollTimer: NodeJS.Timeout | undefined;

    private isPolling = false;

    private isClosed = false;

    constructor(
        private readonly options: {
            host: AgentChatSessionHost;
            query: () => Query | undefined;
            /**
             * Claude Code's `task_id` for a listed shell, which `get_task_output` takes.
             */
            claudeId: (id: string) => string | undefined;
        },
    ) {}

    private outputReader(): TaskOutputReader | undefined {
        const query = this.options.query();
        const read = (query as { getTaskOutput?: unknown } | undefined)?.getTaskOutput;
        if (!query || typeof read !== 'function') return undefined;
        return async (taskId) => (await read.call(query, taskId)) as unknown;
    }

    private runningShells(): string[] {
        return (this.options.host.read().tasks ?? [])
            .filter(
                (task) =>
                    task.kind === 'shell' &&
                    task.status === 'running' &&
                    this.options.claudeId(task.id) !== undefined,
            )
            .map((task) => task.id);
    }

    private stopPolling(): void {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
    }

    private async poll(): Promise<void> {
        if (this.isPolling) return;
        const shells = this.runningShells();
        if (shells.length === 0) {
            this.stopPolling();
            return;
        }
        this.isPolling = true;
        try {
            await Promise.all(shells.map(async (id) => this.readOutput(id)));
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Reads one shell's output tail and publishes it when it changed. A failed read (the task's file is gone, an older
     * CLI) leaves the last tail in place.
     */
    private async readOutput(id: string): Promise<void> {
        const claudeId = this.options.claudeId(id);
        const reader = this.outputReader();
        if (!claudeId || !reader) return;
        let response: unknown;
        try {
            response = await reader(claudeId);
        } catch {
            return;
        }
        if (this.isClosed || !isRecord(response) || typeof response.output !== 'string') return;
        const output = tail(response.output, MAX_AGENT_CHAT_OUTPUT_LENGTH);
        const isTruncated = response.truncated === true || output.length < response.output.length;
        const key = `${isTruncated ? 1 : 0}${output}`;
        if (this.outputs.get(id) === key) return;
        this.outputs.set(id, key);
        this.options.host.applyTask(id, [
            { op: 'state', state: { output, truncated: isTruncated } },
        ]);
        // The final read of an ended shell needs no change detection afterwards.
        const task = this.options.host.read().tasks?.find((candidate) => candidate.id === id);
        if (task?.status !== 'running') this.outputs.delete(id);
    }

    start(): void {
        if (this.pollTimer || this.isClosed || !this.outputReader()) return;
        this.pollTimer = setInterval(() => {
            void this.poll();
        }, OUTPUT_POLL_MS);
        this.pollTimer.unref();
        void this.poll();
    }

    /**
     * Reads an ended shell's output once more; this is its final tail.
     */
    readFinal(id: string): void {
        void this.readOutput(id);
    }

    close(): void {
        this.isClosed = true;
        this.stopPolling();
    }
}
