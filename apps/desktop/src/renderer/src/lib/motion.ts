/**
 * Resolve a motion duration token (`--motion-*` in styles.css `:root`) to milliseconds, so JS timings derive from the
 * same source as CSS transitions and never restate a magic number. Falls back to 200ms, longer than every token, if the
 * token is missing or unparsable.
 */
export function motionDurationMs(token: string): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const match = /^(?<value>[\d.]+)(?<unit>m?s)$/.exec(raw);
    if (!match?.groups) return 200;
    const value = Number(match.groups.value);
    if (Number.isNaN(value)) return 200;
    return match.groups.unit === 's' ? value * 1000 : value;
}

/**
 * Deterministic settlement bound for presence cleanup: transition/animation end events settle presence normally, and
 * this "token + safety margin" timeout guarantees hidden or throttled windows still release exited DOM.
 */
export function motionSettleTimeoutMs(token: string): number {
    return motionDurationMs(token) + 50;
}
