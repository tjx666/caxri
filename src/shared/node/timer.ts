/**
 * Clears an optional Node timer and returns the value callers should retain after cancellation.
 */
export function clearScheduledTimer(timer: NodeJS.Timeout | undefined): undefined {
    if (timer) clearTimeout(timer);
    return;
}
