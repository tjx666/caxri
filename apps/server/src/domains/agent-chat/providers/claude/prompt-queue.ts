import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatItem, AgentChatPatchOperation } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

/**
 * The prompt stream the SDK reads user messages from. It stays open for the whole process lifetime so one Claude Code
 * process serves every turn; ending it closes Claude Code's stdin.
 */
export class PromptQueue implements AsyncIterable<SDKUserMessage> {
    private readonly queued: SDKUserMessage[] = [];

    private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;

    private isEnded = false;

    push(message: SDKUserMessage): void {
        if (this.isEnded) return;
        const waiter = this.waiter;
        this.waiter = undefined;
        if (waiter) waiter({ value: message, done: false });
        else this.queued.push(message);
    }

    end(): void {
        this.isEnded = true;
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.({ value: undefined, done: true });
    }

    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
            next: async () => {
                const message = this.queued.shift();
                if (message) return { value: message, done: false };
                if (this.isEnded) return { value: undefined, done: true };
                return new Promise((resolve) => {
                    this.waiter = resolve;
                });
            },
        };
    }
}

/**
 * The messages steered into the running turn that Claude Code has not taken in yet. A steered prompt goes out with
 * `priority: 'next'`, which Claude Code folds in only at its next model request, so a reply already streaming never saw
 * it. The projection shows such a message at once but marked `isAwaitingAgent`, which keeps it after every later item,
 * and the mark comes off when Claude Code echoes the prompt's uuid (`--replay-user-messages`). That echo arrives at the
 * fold, right before the request that reads it, not when the prompt is received: verified with Agent SDK 0.3.304 for a
 * steer sent while a tool ran and one sent while text streamed.
 */
export class ClaudeSteers {
    private readonly awaiting = new Map<string, AgentChatItem>();

    constructor(private readonly apply: (operations: AgentChatPatchOperation[]) => void) {}

    /**
     * The item to show for a steered prompt, marked until Claude Code takes it in.
     */
    hold(item: AgentChatItem): AgentChatItem {
        if (item.type !== 'userMessage') return item;
        this.awaiting.set(item.id, item);
        return { ...item, isAwaitingAgent: true };
    }

    /**
     * Claude Code echoed a prompt it took in; a held one now stays where it is.
     */
    onReplay(uuid: string): void {
        const item = this.awaiting.get(uuid);
        if (!item) return;
        this.awaiting.delete(uuid);
        this.apply([{ op: 'upsertItem', item }]);
    }

    /**
     * Releases every held prompt once no turn runs, or the process ended, without folding it in (an interrupt, a
     * crash), so none keeps pushing later items above it.
     */
    releaseAll(): void {
        if (this.awaiting.size === 0) return;
        const items = this.awaiting.values().toArray();
        this.awaiting.clear();
        this.apply(items.map((item) => ({ op: 'upsertItem', item })));
    }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new CaxriError('TIMEOUT', 'Claude did not respond')),
            timeoutMs,
        );
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
