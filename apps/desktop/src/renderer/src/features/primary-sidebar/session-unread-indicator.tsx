import type { SessionRecord } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import {
    sessionActivityPresentation,
    sessionToneBackgroundClassName,
    sessionToneBorderClassName,
    sessionUnreadTone,
} from './session-activity';

/**
 * The ring reuses the activity tone palette (warning/danger) instead of `--accent` — DESIGN.md reserves accent for the
 * single focused pane/tab, and the PrimarySidebar stays entirely neutral otherwise. `lastAttentionKind` is a subset of
 * `AgentActivityState`'s keys, so `sessionUnreadTone` reads the same presentation table as the activity dot; it just
 * collapses everything but a failure to `warning` so no unread row can render as inert grey.
 */
export function SessionUnreadIndicator({ session }: { session: SessionRecord }) {
    if (!session.hasUnread) return null;
    const attentionKind = session.lastAttentionKind ?? 'unknown';
    const tone = sessionUnreadTone(attentionKind);
    const label = `Unread: ${sessionActivityPresentation(attentionKind).label}`;
    return (
        <span
            role="img"
            aria-label={label}
            className={cn(
                'session-unread relative flex size-3.5 flex-none items-center justify-center rounded-full border',
                sessionToneBorderClassName(tone),
            )}
            data-attention-kind={session.lastAttentionKind}
            title={label}
        >
            {/* Expanding-ripple ring that makes an unread row noticeable at primary-sidebar-glance distance. */}
            <span
                aria-hidden="true"
                className={cn(
                    'absolute inset-0 rounded-full border opacity-75 motion-safe:animate-ping motion-reduce:hidden',
                    sessionToneBorderClassName(tone),
                )}
            />
            <span className={cn('size-2 rounded-full', sessionToneBackgroundClassName(tone))} />
        </span>
    );
}
