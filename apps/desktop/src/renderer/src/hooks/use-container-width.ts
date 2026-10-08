import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * Tracks an element's content-box width via `ResizeObserver`, quantized down to the nearest `bucket` px. Consumers that
 * derive layout thresholds from this value (e.g. status bar chip priority) see a stable, rounded number instead of
 * every sub-pixel fluctuation, which is what keeps a width sitting near a breakpoint from flickering a chip in and out
 * on every frame: hysteresis by quantization rather than by tracking resize direction.
 */
export function useContainerWidth<T extends HTMLElement>(
    bucket = 8,
): readonly [RefObject<T | null>, number] {
    const reference = useRef<T>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const element = reference.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            const next = Math.floor(entry.contentRect.width / bucket) * bucket;
            setWidth((current) => (current === next ? current : next));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [bucket]);

    return [reference, width] as const;
}
