import type { ReactNode, TransitionEvent } from 'react';
import { useEffect, useState } from 'react';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { motionSettleTimeoutMs } from '../lib/motion';
import { cn } from '../lib/utilities';

interface DisclosureMotionProperties {
    /**
     * Only user-toggled disclosures animate; restored startup state renders still.
     */
    animate: boolean;
    children: ReactNode | (() => ReactNode);
    className?: string;
    expanded: boolean;
    hidden?: boolean;
    id?: string;
    /**
     * Disclosure site name, exposed as `data-disclosure` for tests and debugging.
     */
    kind: string;
}

/**
 * Presence wrapper for user-triggered disclosures, driving the native height 0 ↔ auto transition in styles.css
 * (`.disclosure-motion`, `interpolate-size: allow-keywords`). Expanding mounts content in the same commit that flips
 * `data-expanded`, so the browser sees an ordinary style change and interpolates to the content's intrinsic height.
 * Collapsing keeps content mounted only until the height transition settles: `transitionend` normally, with a
 * token-derived timeout as the deterministic fallback for hidden or throttled windows, then releases the hidden DOM so
 * queries, watchers, and large subtrees never linger. `inert` removes collapsing content from focus and navigation
 * immediately.
 */
export function DisclosureMotion({
    animate,
    children,
    className,
    expanded,
    hidden = false,
    id,
    kind,
}: DisclosureMotionProperties) {
    const isReducedMotion = useShouldReduceMotion();
    const isMotionEnabled = animate && !isReducedMotion;
    const isInteractive = expanded && !hidden;
    const [exitPresent, setExitPresent] = useState(false);
    /**
     * Collapse presence must begin in the same render that drops `expanded`: an effect runs after the commit that would
     * already have unmounted the content. Track the previous value and flip presence during render (React's sanctioned
     * derived-state pattern).
     */
    const [previousExpanded, setPreviousExpanded] = useState(expanded);
    if (previousExpanded !== expanded) {
        setPreviousExpanded(expanded);
        setExitPresent(!expanded && isMotionEnabled);
    }
    /**
     * A live reduced-motion toggle mid-collapse must release the exit DOM immediately.
     */
    if (exitPresent && !isMotionEnabled) setExitPresent(false);

    useEffect(() => {
        if (!exitPresent) return;
        const timer = setTimeout(
            () => setExitPresent(false),
            motionSettleTimeoutMs('--motion-collapse'),
        );
        return () => clearTimeout(timer);
    }, [exitPresent]);

    const isPresent = expanded || exitPresent;
    const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
        if (!expanded && event.target === event.currentTarget && event.propertyName === 'height')
            setExitPresent(false);
    };

    return (
        <div
            id={id}
            className={cn('disclosure-motion', hidden && 'hidden', className)}
            data-disclosure={kind}
            data-expanded={expanded}
            data-motion={animate || undefined}
            aria-hidden={!isInteractive}
            inert={!isInteractive ? true : undefined}
            onTransitionEnd={onTransitionEnd}
        >
            {isPresent ? (typeof children === 'function' ? children() : children) : null}
        </div>
    );
}
