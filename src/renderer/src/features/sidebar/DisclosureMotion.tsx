import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '../../lib/utils';

interface DisclosureMotionProps {
    animate: boolean;
    children: ReactNode | (() => ReactNode);
    className?: string;
    expanded: boolean;
    hidden?: boolean;
    id?: string;
    kind: 'archive' | 'project';
}

/**
 * Keeps lazy disclosure contents mounted only through collapse so CSS can interpolate intrinsic
 * height, then releases their hidden DOM. `inert` removes exit content from navigation immediately.
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
    const interactive = expanded && !hidden;
    const motionEnabled = animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const [exitPresent, setExitPresent] = useState(false);
    const [visualExpanded, setVisualExpanded] = useState(expanded);
    const present = expanded || (motionEnabled && (visualExpanded || exitPresent));

    useEffect(() => {
        if (!motionEnabled) return;
        if (expanded) {
            const frame = requestAnimationFrame(() => {
                setExitPresent(false);
                setVisualExpanded(true);
            });
            return () => cancelAnimationFrame(frame);
        }

        const frame = requestAnimationFrame(() => {
            setExitPresent(true);
            setVisualExpanded(false);
        });
        /** Slightly exceeds the 130ms CSS collapse as a deterministic transition-end fallback. */
        const timer = window.setTimeout(() => setExitPresent(false), 150);
        return () => {
            cancelAnimationFrame(frame);
            window.clearTimeout(timer);
        };
    }, [expanded, motionEnabled]);

    return (
        <div
            id={id}
            className={cn('disclosure-motion grid', hidden && 'hidden', className)}
            data-disclosure={kind}
            data-expanded={motionEnabled ? visualExpanded : expanded}
            data-motion={animate || undefined}
            aria-hidden={!interactive}
            inert={!interactive ? true : undefined}
        >
            <div className="min-h-0 overflow-hidden">
                {present ? (typeof children === 'function' ? children() : children) : null}
            </div>
        </div>
    );
}
