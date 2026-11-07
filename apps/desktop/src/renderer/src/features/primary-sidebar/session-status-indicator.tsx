import type { ReactNode } from 'react';
import { useId } from 'react';

import type { SessionRecord } from '@caxri/protocol';
import { CircleQuestionMark, CircleX, Clock, Unplug } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { BackgroundArc, RunningArc } from './running-arc';
import type { SessionStatus, SessionStatusTerminal } from './session-status';
import { sessionStatus } from './session-status';
import { syncSpinPhase } from './shared-spin-phase';

/**
 * The slot's class per visible status: the `session-status-<kind>` hook that tests and styles read, and the tone. Only
 * attention (warning) and a failed delegation (danger) are colored; every other signal stays `--muted` so a list of
 * working Agents never turns into a wall of color.
 */
const STATUS_SLOT_CLASS: Record<Exclude<SessionStatus['kind'], 'default'>, string> = {
    attention: 'session-status-attention text-warning',
    detached: 'session-status-detached text-muted',
    failed: 'session-status-failed text-danger',
    running: 'session-status-running text-muted',
    usageWait: 'session-status-usage-wait text-muted',
};

/**
 * The lifecycle glyph shared by the PrimarySidebar's Project tree (right edge, where Codex and most chat lists put it),
 * the Activity view (ahead of the title), and the MRU switcher: Pending Attention breathes in amber until it is marked
 * Done and pings on arrival while unread, running spins, a detached Agent shows a static unplugged glyph, and a Chat
 * waiting for a usage limit to reset shows a clock. The leading Agent icon stays a plain brand-color mark, so its color
 * alone tells Agents apart.
 *
 * Lifecycle outranks delivery: while a signal shows, the Session's pull request glyph (the `fallback`) steps aside and
 * stays reachable from the hover card and the row menu. It returns the moment the Agent settles and is marked Done.
 *
 * A settled Session keeps the element in the DOM (its `data-session-status` is the contract lifecycle assertions read)
 * but collapses it to nothing, so callers that right-align their glyphs do not strand a neighbour a slot short of the
 * row's right edge. Callers whose neighbouring column must stay on one vertical line pass `reserveSlot` instead.
 */
export function SessionStatusIndicator({
    className,
    approvalPending,
    delegationFailed,
    fallback,
    reserveSlot = false,
    session,
    terminal,
}: {
    /**
     * True for a nested Chat Session whose delegation carries a permission request that waits on the user: the amber
     * cue that survives reading (see `sessionStatus`). Only nested rows pass it.
     */
    approvalPending?: boolean;
    className?: string;
    /**
     * True for a nested Session whose delegation failed (see `sessionStatus`). Only nested rows pass it.
     */
    delegationFailed?: boolean;
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
    const { t } = useTranslation();
    const status = sessionStatus(session, terminal ?? {}, t, {
        approvalPending,
        delegationFailed,
    });
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
                    STATUS_SLOT_CLASS[status.kind],
                    className,
                )}
                data-agent-operation={terminal?.agentOperation}
                data-attention-kind={
                    status.kind === 'attention' ? session.lastAttentionKind : undefined
                }
                data-attention-pending={
                    status.kind === 'attention' && status.isPending ? '' : undefined
                }
                data-attention-variant={status.kind === 'attention' ? status.variant : undefined}
                data-session-status={status.kind}
            >
                <SessionStatusGlyph
                    // The attention ripple plays three times per mount; a new kind of attention event remounts it so the
                    // event is noticed even when the Session never passed through running in between.
                    key={
                        status.kind === 'attention'
                            ? `${session.lastAttentionKind}:${status.variant}:${status.isPending ? 'pending' : 'unread'}`
                            : status.kind
                    }
                    status={status}
                />
            </span>
            <span id={descriptionId} hidden>
                {status.ariaDescription}
            </span>
        </>
    );
}

/**
 * The glyph inside a visible status slot: a breathing amber mark for attention (with an arrival ripple while unread),
 * an unplugged plug when detached, a circled X when a delegated task failed, and a running arc that turns into a slower
 * dotted ring while the Agent only waits on its own background work.
 */
function SessionStatusGlyph({ status }: { status: Exclude<SessionStatus, { kind: 'default' }> }) {
    if (status.kind === 'detached') return <Unplug aria-hidden="true" size={12} />;
    if (status.kind === 'usageWait') return <Clock aria-hidden="true" size={12} />;
    // The same circled X the Chat's failed tool rows and the Activity view draw, at the question mark's size and weight.
    if (status.kind === 'failed')
        return <CircleX aria-hidden="true" size={14} strokeWidth={2.25} />;
    if (status.kind === 'running')
        return status.variant === 'background' ? <BackgroundArc /> : <RunningArc />;
    return (
        <>
            {!status.isPending && (
                <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full border border-warning opacity-75 motion-safe:animate-ping motion-safe:[animation-fill-mode:forwards] motion-safe:[animation-iteration-count:3] motion-reduce:hidden"
                    data-session-status-ripple=""
                />
            )}
            <AttentionPulse>
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
            </AttentionPulse>
        </>
    );
}

/**
 * The steady breathing that keeps an attention glyph moving for as long as the item waits on the user, so a Needs
 * attention row stays as noticeable as a spinning Working row. It animates opacity on an HTML wrapper, which the
 * compositor runs off the main thread (see `RunningArc`), and every attention glyph shares one phase so a column of
 * them breathes together. Reduced motion leaves it still.
 */
function AttentionPulse({ children }: { children: ReactNode }) {
    return (
        <span
            aria-hidden="true"
            className="relative flex size-3.5 items-center justify-center motion-safe:animate-pulse"
            data-session-status-pulse=""
            ref={syncSpinPhase}
        >
            {children}
        </span>
    );
}
