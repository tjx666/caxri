export type E2EErrorSource = 'host' | 'main' | 'renderer' | 'runtime';

export interface E2EErrorEvent {
    source: E2EErrorSource;
    event: string;
    code: string;
}

export interface E2EErrorAllowance extends E2EErrorEvent {
    count: number;
}

function keyOf(error: E2EErrorEvent): string {
    return `${error.source}/${error.event}/${error.code}`;
}

function formatCounts(counts: ReadonlyMap<string, number>): string {
    return Array.from(counts)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => `${key} x${count}`)
        .join(', ');
}

/**
 * Enforces the E2E error contract with exact tuples and counts. Missing allowances fail as well as unexpected errors so
 * a stale exception suppression cannot silently remain after a repair.
 */
export function assertE2EErrorPolicy(
    actual: readonly E2EErrorEvent[],
    allowances: readonly E2EErrorAllowance[],
): void {
    const expectedCounts = new Map<string, number>();
    for (const allowance of allowances) {
        const values = [allowance.source, allowance.event, allowance.code];
        if (
            values.some((value) => !value.trim() || value.includes('*')) ||
            !Number.isSafeInteger(allowance.count) ||
            allowance.count <= 0
        ) {
            throw new Error('E2E error allowances must use exact non-empty values and counts');
        }
        const key = keyOf(allowance);
        if (expectedCounts.has(key)) throw new Error(`Duplicate E2E error allowance: ${key}`);
        expectedCounts.set(key, allowance.count);
    }

    const actualCounts = new Map<string, number>();
    for (const error of actual) {
        const key = keyOf(error);
        actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
    }

    const unexpected = new Map<string, number>();
    const missing = new Map<string, number>();
    for (const [key, count] of actualCounts) {
        const expected = expectedCounts.get(key) ?? 0;
        if (count > expected) unexpected.set(key, count - expected);
    }
    for (const [key, count] of expectedCounts) {
        const observed = actualCounts.get(key) ?? 0;
        if (count > observed) missing.set(key, count - observed);
    }

    const failures = [
        unexpected.size > 0 ? `Unexpected E2E errors: ${formatCounts(unexpected)}` : undefined,
        missing.size > 0 ? `Missing E2E errors: ${formatCounts(missing)}` : undefined,
    ].filter(Boolean);
    if (failures.length > 0)
        throw new Error(failures.join('\n') || 'Unexpected E2E error-count mismatch');
}
