import { CaxriError } from '@caxri/protocol';

/**
 * Tracks individual Stop attempts so rejecting one cannot cancel another accepted request.
 */
export class ChatTurnInterruption {
    private turnId: string | undefined;
    private readonly attempts = new Set<symbol>();

    request(turnId: string): () => void {
        if (turnId !== this.turnId) {
            this.clear();
            this.turnId = turnId;
        }
        const attempt = Symbol();
        this.attempts.add(attempt);
        return () => {
            this.attempts.delete(attempt);
        };
    }

    reason(turnId: string | undefined): 'user' | undefined {
        return turnId !== undefined && turnId === this.turnId && this.attempts.size > 0
            ? 'user'
            : undefined;
    }

    clear(turnId?: string): void {
        if (turnId !== undefined && turnId !== this.turnId) return;
        this.turnId = undefined;
        this.attempts.clear();
    }
}

/**
 * A refused Stop leaves its turn running; a timed-out Stop closes the owned provider on the user's behalf.
 */
export async function interruptChatTurn(options: {
    turnId: string;
    readActiveTurnId: () => string | undefined;
    request: () => Promise<unknown>;
    rejectStop: (() => void) | undefined;
    close: () => Promise<void>;
}): Promise<void> {
    try {
        await options.request();
    } catch (error) {
        if (error instanceof CaxriError && error.code === 'TIMEOUT') {
            await options.close();
            return;
        }
        options.rejectStop?.();
        if (options.readActiveTurnId() === options.turnId) throw error;
    }
}
