import { useEffect, useState } from 'react';

/**
 * Reactive `prefers-reduced-motion: reduce` subscription — the single Renderer-wide way to
 * read the preference. CSS layers honor it through media queries; JS layers (Motion
 * transitions, presence cleanup) must use this hook so a live OS toggle takes effect without
 * a reload. Never read `matchMedia` inline for this query: a non-reactive read freezes the
 * first value for the component's lifetime.
 */
export function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = (): void => setReduced(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return reduced;
}

/**
 * Resolve a motion duration token (`--motion-*` in styles.css `:root`) to milliseconds, so JS
 * timings derive from the same source as CSS transitions and never restate a magic number.
 * Falls back to 200ms — longer than every token — if the token is missing or unparsable.
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
 * Deterministic settlement bound for presence cleanup: transition/animation end events settle
 * presence normally, and this "token + safety margin" timeout guarantees hidden or throttled
 * windows still release exited DOM.
 */
export function motionSettleTimeoutMs(token: string): number {
    return motionDurationMs(token) + 50;
}
