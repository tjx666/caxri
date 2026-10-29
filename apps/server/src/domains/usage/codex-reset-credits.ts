import type { UsageResetCredits } from '@caxri/protocol';

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * One reset credit's expiry in milliseconds. The app-server schema types `expiresAt` as Unix seconds; an ISO 8601
 * string is read too, so a backend that switches representation does not silently hide the reminder.
 */
function codexResetCreditExpiry(value: unknown): number | undefined {
    if (typeof value === 'number') return value > 0 ? Math.round(value * 1000) : undefined;
    if (typeof value !== 'string') return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Codex's `rateLimitResetCredits` from `account/rateLimits/read` (`RateLimitResetCreditsSummary` in the codex-cli
 * app-server schema): `availableCount` plus, when the backend sent details, one row per credit. The soonest expiry is
 * taken over rows whose `status` is `available`; a row without an expiry never expires and sets none. Undefined for a
 * missing summary, a malformed count, and no available credit, so a field the Codex build lacks reads as unknown.
 */
export function codexResetCredits(value: unknown): UsageResetCredits | undefined {
    const summary = record(value);
    if (!summary) return undefined;
    const { availableCount } = summary;
    if (typeof availableCount !== 'number' || !Number.isFinite(availableCount)) return undefined;
    const count = Math.floor(availableCount);
    if (count <= 0) return undefined;
    const rows = Array.isArray(summary.credits) ? summary.credits : [];
    const expiries = rows.flatMap((row) => {
        const credit = record(row);
        if (credit?.status !== 'available') return [];
        const expiresAt = codexResetCreditExpiry(credit.expiresAt);
        return expiresAt === undefined ? [] : [expiresAt];
    });
    return {
        availableCount: count,
        ...(expiries.length > 0 && { nextExpiresAt: Math.min(...expiries) }),
    };
}
