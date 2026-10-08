import { useEffect, useState } from 'react';

/**
 * Reactive `prefers-reduced-motion: reduce` subscription: the single Renderer-wide way to read the preference. CSS
 * layers honor it through media queries; JS layers (Motion transitions, presence cleanup) must use this hook so a live
 * OS toggle takes effect without a reload. Never read `matchMedia` inline for this query: a non-reactive read freezes
 * the first value for the component's lifetime.
 */
export function useShouldReduceMotion(): boolean {
    const [reduced, setReduced] = useState(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    useEffect(() => {
        const media = matchMedia('(prefers-reduced-motion: reduce)');
        const update = (): void => setReduced(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return reduced;
}
