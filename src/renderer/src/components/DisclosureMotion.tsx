import { useEffect, useState, type ReactNode, type TransitionEvent } from 'react';

import { motionSettleTimeoutMs, usePrefersReducedMotion } from '../lib/motion';
import { cn } from '../lib/utils';

interface DisclosureMotionProps {
    /** Only user-toggled disclosures animate; restored startup state renders still. */
    animate: boolean;
    children: ReactNode | (() => ReactNode);
    className?: string;
    expanded: boolean;
    hidden?: boolean;
    id?: string;
    /** Disclosure site name, exposed as `data-disclosure` for tests and debugging. */
    kind: string;
}

/**
 * Presence wrapper for user-triggered disclosures, driving the native height 0 ↔ auto
 * transition in styles.css (`.disclosure-motion`, `interpolate-size: allow-keywords`).
 * Expanding mounts content in the same commit that flips `data-expanded`, so the browser sees
 * an ordinary style change and interpolates to the content's intrinsic height. Collapsing
 * keeps content mounted only until the height transition settles — `transitionend` normally,
 * with a token-derived timeout as the deterministic fallback for hidden or throttled windows —
 * then releases the hidden DOM so queries, watchers, and large subtrees never linger.
 * `inert` removes collapsing content from focus and navigation immediately.
 */
export function DisclosureMotion({
    animate,
    children,
    className,
    expanded,
    hidden = false,
    id,
    kind,
}: DisclosureMotionProps) {
    const reducedMotion = usePrefersReducedMotion();
    const motionEnabled = animate && !reducedMotion;
    const interactive = expanded && !hidden;
    const [exitPresent, setExitPresent] = useState(false);
    /**
     * Collapse presence must begin in the same render that drops `expanded` — an effect runs
     * after the commit that would already have unmounted the content. Track the previous
     * value and flip presence during render (React's sanctioned derived-state pattern).
     */
    const [previousExpanded, setPreviousExpanded] = useState(expanded);
    if (previousExpanded !== expanded) {
        setPreviousExpanded(expanded);
        setExitPresent(!expanded && motionEnabled);
    }
    /** A live reduced-motion toggle mid-collapse must release the exit DOM immediately. */
    if (exitPresent && !motionEnabled) setExitPresent(false);

    useEffect(() => {
        if (!exitPresent) return;
        const timer = window.setTimeout(
            () => setExitPresent(false),
            motionSettleTimeoutMs('--motion-collapse'),
        );
        return () => window.clearTimeout(timer);
    }, [exitPresent]);

    const present = expanded || exitPresent;
    const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
        if (event.target === event.currentTarget && event.propertyName === 'height' && !expanded)
            setExitPresent(false);
    };

    return (
        <div
            id={id}
            className={cn('disclosure-motion', hidden && 'hidden', className)}
            data-disclosure={kind}
            data-expanded={expanded}
            data-motion={animate || undefined}
            aria-hidden={!interactive}
            inert={!interactive ? true : undefined}
            onTransitionEnd={onTransitionEnd}
        >
            {present ? (typeof children === 'function' ? children() : children) : null}
        </div>
    );
}
