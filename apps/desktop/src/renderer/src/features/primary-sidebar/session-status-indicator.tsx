import type { ReactNode } from 'react';
import { useId } from 'react';

import type { SessionRecord } from '@caxri/protocol';
import { CircleQuestionMark, Unplug } from 'lucide-react';

import { cn } from '../../lib/utilities';
import type { SessionStatusTerminal } from './session-status';
import { sessionStatus } from './session-status';

/**
 * The right-edge lifecycle glyph shared by the PrimarySidebar and the MRU switcher, in the place Codex and most chat
 * lists put it: unread attention pings until it is read, running spins, and a detached Agent shows a static unplugged
 * glyph. The leading Agent icon stays a plain brand-color mark, so its color alone tells Agents apart.
 *
 * Lifecycle outranks delivery: while a signal shows, the Session's pull request glyph (the `fallback`) steps aside and
 * stays reachable from the hover card and the row menu. It returns the moment the Agent settles and is read.
 *
 * A settled Session keeps the element in the DOM (its `data-session-status` is the contract lifecycle assertions read)
 * but collapses it to nothing, so callers that right-align their glyphs do not strand a neighbour a slot short of the
 * row's right edge. Callers whose neighbouring column must stay on one vertical line pass `reserveSlot` instead.
 */
export function SessionStatusIndicator({
    className,
    fallback,
    reserveSlot = false,
    session,
    terminal,
}: {
    className?: string;
    /**
     * Lower-priority content occupies the same slot only when no lifecycle signal is visible.
     */
    fallback?: ReactNode;
    /**
     * Renders the settled state as a 14px placeholder rather than collapsing it. Use it when a neighbouring
     * variable-width column (the MRU switcher's relative timestamp) would otherwise shift as the status appears.
     */
    reserveSlot?: boolean;
    session: SessionRecord;
    terminal?: SessionStatusTerminal;
}) {
    const descriptionId = useId();
    const status = sessionStatus(session, terminal);
    if (status.kind === 'default')
        return (
            <>
                <span
                    aria-hidden="true"
                    className={cn(
                        'session-status flex-none',
                        reserveSlot && !fallback ? 'size-3.5' : 'hidden',
                        className,
                    )}
                    data-session-status="default"
                />
                {fallback}
            </>
        );

    /*
     * The full sentence goes in a hidden sibling referenced by `aria-describedby`: hidden content is skipped when the
     * row computes its name from content, but still read as the glyph's description.
     */
    return (
        <>
            <span
                role="img"
                aria-label={status.ariaLabel}
                aria-describedby={descriptionId}
                className={cn(
                    'session-status relative flex size-3.5 flex-none items-center justify-center',
                    status.kind === 'attention'
                        ? 'session-status-attention text-warning'
                        : status.kind === 'detached'
                          ? 'session-status-detached text-muted'
                          : 'session-status-running text-muted',
                    className,
                )}
                data-agent-operation={terminal?.agentOperation}
                data-attention-kind={
                    status.kind === 'attention' ? session.lastAttentionKind : undefined
                }
                data-attention-variant={status.kind === 'attention' ? status.variant : undefined}
                data-session-status={status.kind}
            >
                {status.kind === 'attention' ? (
                    <>
                        <span
                            aria-hidden="true"
                            className="absolute inset-0 rounded-full border border-warning opacity-75 motion-safe:animate-ping motion-reduce:hidden"
                            data-session-status-ripple=""
                        />
                        {status.variant === 'waiting' ? (
                            <CircleQuestionMark aria-hidden="true" size={14} strokeWidth={2.25} />
                        ) : (
                            <>
                                <span
                                    aria-hidden="true"
                                    className="size-3.5 rounded-full border border-warning"
                                />
                                <span
                                    aria-hidden="true"
                                    className="absolute size-2 rounded-full bg-warning"
                                />
                            </>
                        )}
                    </>
                ) : status.kind === 'detached' ? (
                    <Unplug aria-hidden="true" size={12} />
                ) : (
                    <RunningArc />
                )}
            </span>
            <span id={descriptionId} hidden>
                {status.ariaDescription}
            </span>
        </>
    );
}

/**
 * A thin open ring that spins in the surrounding text color, the way Codex marks a working thread. It is deliberately
 * monochrome: a colored arc on every running row reads as a wall of color once several Agents work at once, and the
 * motion alone already separates a working Session from a settled one. The 10px ring sits centered in the 14px status
 * slot, so it shares one vertical line with the attention and pull request glyphs. The dash covers three quarters of
 * the circumference and its round caps eat into the rest, leaving about the opening Codex shows. Reduced motion leaves
 * it still.
 */
export function RunningArc() {
    return (
        <svg
            aria-hidden="true"
            className="size-2.5 flex-none motion-safe:animate-spin"
            data-session-status-arc=""
            viewBox="0 0 20 20"
        >
            <circle
                cx="10"
                cy="10"
                fill="none"
                r="8.5"
                stroke="currentColor"
                strokeDasharray="40 13.4"
                strokeLinecap="round"
                strokeWidth="3"
            />
        </svg>
    );
}
