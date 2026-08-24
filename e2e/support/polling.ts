import { expect } from '@playwright/test';

export interface PollUntilOptions {
    intervals?: number[];
    /**
     * Returns true only for a callback failure that the caller owns as an expected convergence state.
     */
    isRetryableError?: (error: unknown) => boolean;
    message?: string;
    timeout?: number;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Retries an explicitly classified transient read until it produces a matching value. Use this only when the read can
 * throw while its target is still converging; unexpected Host, IPC, permission, and filesystem errors should remain on
 * ordinary `expect.poll` paths so their first causal failure is not delayed until a timeout.
 */
export async function pollUntil<T>(
    read: () => Promise<T | null | undefined> | T | null | undefined,
    isMatch: (value: T) => boolean,
    options?: PollUntilOptions,
): Promise<T> {
    const { isRetryableError, ...pollOptions } = options ?? {};
    let matchedValue: T | undefined;
    let lastCallbackError: unknown;
    let terminalError: { value: unknown } | undefined;

    try {
        await expect
            .poll(async () => {
                let value: T | null | undefined;
                try {
                    value = await read();
                } catch (error) {
                    let isRetryable: boolean;
                    try {
                        isRetryable = isRetryableError?.(error) ?? false;
                    } catch (classifierError) {
                        terminalError = { value: classifierError };
                        throw classifierError;
                    }
                    if (!isRetryable) {
                        terminalError = { value: error };
                        throw error;
                    }
                    lastCallbackError = error;
                    return false;
                }
                if (value === null || value === undefined) return false;
                try {
                    if (!isMatch(value)) return false;
                } catch (error) {
                    terminalError = { value: error };
                    throw error;
                }
                matchedValue = value;
                return true;
            }, pollOptions)
            .toBe(true);
    } catch (error) {
        if (terminalError) throw terminalError.value;
        if (lastCallbackError !== undefined) {
            throw new Error(
                `${errorMessage(error)}\nLast callback error: ${errorMessage(lastCallbackError)}`,
                { cause: error },
            );
        }
        throw error;
    }

    if (matchedValue === undefined) throw new Error('Polling completed without a matching value');
    return matchedValue;
}
