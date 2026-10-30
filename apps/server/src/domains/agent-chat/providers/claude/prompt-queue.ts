import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
