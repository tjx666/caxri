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

/**
 * A CSS `cubic-bezier()` as the control-point tuple Motion's `ease` option accepts.
 */
export type MotionCubicBezier = readonly [number, number, number, number];

/**
 * The CSS easing keywords as control points (CSS Easing Functions Level 1), so a keyword token still resolves.
 */
const CSS_EASE: MotionCubicBezier = [0.25, 0.1, 0.25, 1];
const EASING_KEYWORDS: Readonly<Partial<Record<string, MotionCubicBezier>>> = {
    'ease': CSS_EASE,
    'ease-in': [0.42, 0, 1, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
    'ease-out': [0, 0, 0.58, 1],
    'linear': [0, 0, 1, 1],
};

/**
 * Resolve a motion easing token (`--motion-ease-*`) to control points, so a Motion transition runs on the same curve as
 * the CSS layers instead of a library preset such as `'easeOut'` that only approximates it. Falls back to the CSS
 * `ease` keyword if the token is missing or not a `cubic-bezier()`/keyword value.
 */
export function motionEasing(token: string): MotionCubicBezier {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const keyword = EASING_KEYWORDS[raw];
    if (keyword) return keyword;
    const match = /^cubic-bezier\((?<points>[^)]*)\)$/.exec(raw);
    const points = match?.groups?.points.split(',').map((point) => Number(point.trim()));
    if (points?.length !== 4 || points.some((point) => Number.isNaN(point))) return CSS_EASE;
    return [points[0], points[1], points[2], points[3]];
}
