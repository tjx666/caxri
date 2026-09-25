type TimelineStatus = 'available' | 'missing' | 'unsupported';

const READINESS_TIMEOUT_MS = 3_000;
const READINESS_POLL_MS = 150;

/**
 * A new Agent Terminal can exist before its provider session and transcript are bound. Wait briefly for a readable
 * Conversation before opening the detail; a missing transcript or failed read must never turn a confirmed create into a
 * retryable error.
 */
export async function waitForCreatedConversation(
    read: () => Promise<{ status: TimelineStatus }>,
): Promise<'ready' | 'fallback'> {
    let isStopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'fallback'>((resolve) => {
        timeout = setTimeout(() => resolve('fallback'), READINESS_TIMEOUT_MS);
    });
    const poll = async (): Promise<'ready' | 'fallback'> => {
        while (!isStopped) {
            try {
                // eslint-disable-next-line no-await-in-loop -- each snapshot must settle before the next read
                const { status } = await read();
                if (status === 'available') return 'ready';
                if (status === 'unsupported') return 'fallback';
            } catch {
                // The Session is already created; a transient read error cannot classify that outcome.
            }
            // eslint-disable-next-line no-await-in-loop -- a missing transcript is retried until the bounded deadline
            await new Promise<void>((resolve) => setTimeout(resolve, READINESS_POLL_MS));
        }
        return 'fallback';
    };
    try {
        return await Promise.race([poll(), deadline]);
    } finally {
        isStopped = true;
        clearTimeout(timeout);
    }
}
