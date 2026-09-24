export interface TerminalFrameBatch {
    push(chunk: string): void;
    reset(): void;
}

/**
 * Batches output at the browser frame boundary without retaining a prior Terminal generation's pending bytes.
 */
export const createTerminalFrameBatch = ({
    cancel,
    schedule,
    write,
}: {
    cancel: (frame: number) => void;
    schedule: (callback: () => void) => number;
    write: (text: string) => void;
}): TerminalFrameBatch => {
    let pending = '';
    let scheduledFrame: number | null = null;
    let generation = 0;
    return {
        push: (chunk) => {
            if (chunk.length === 0) return;
            pending += chunk;
            if (scheduledFrame !== null) return;
            const expectedGeneration = generation;
            scheduledFrame = schedule(() => {
                if (expectedGeneration !== generation) return;
                scheduledFrame = null;
                const next = pending;
                pending = '';
                if (next) write(next);
            });
        },
        reset: () => {
            generation += 1;
            pending = '';
            if (scheduledFrame !== null) cancel(scheduledFrame);
            scheduledFrame = null;
        },
    };
};
