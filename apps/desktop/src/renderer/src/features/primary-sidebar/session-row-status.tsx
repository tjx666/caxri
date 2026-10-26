import type { SessionPullRequest, SessionRecord } from '@caxri/protocol';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { cn } from '../../lib/utilities';
import { SessionPullRequestIndicator } from './session-pull-request-indicator';
import type { SessionStatusTerminal } from './session-status';
import { SessionStatusIndicator } from './session-status-indicator';

/**
 * A row's trailing status slot: the Session's lifecycle glyph, else its PR, or the Switch to Pinned Session chord while
 * its modifier is held.
 *
 * Lifecycle signals take priority over the PR. The wrapper follows the rendered glyph's width, so an idle Session with
 * no PR gives the otherwise invisible 14px slot back to its title; every visible glyph still lands on the same right
 * edge. With no visible glyph the wrapper is not rendered at all (`hidden` until a child that is not itself `.hidden`
 * exists): a zero-width flex item still costs the row's 8px gap, which left an idle row's title fading out well short
 * of the row's edge.
 */
export function SessionRowStatus({
    className,
    pullRequest,
    renaming,
    renameSuggesting,
    session,
    shortcutHint,
    terminal,
}: {
    /**
     * Collapses the slot on row hover so Pin and Archive own the right edge; what the glyph said stays in the hover
     * card.
     */
    className: string;
    pullRequest?: SessionPullRequest;
    renaming: boolean;
    /**
     * An AI name is being generated in this row's editor. Its button spinner already says the row is busy, so a running
     * Session's spinner beside it would read as a second, unrelated load.
     */
    renameSuggesting: boolean;
    session: SessionRecord;
    shortcutHint?: string;
    terminal?: SessionStatusTerminal;
}) {
    if (renaming && renameSuggesting) return;
    if (shortcutHint)
        return (
            <ShortcutBadge
                compact
                className={cn('session-shortcut-hint', className)}
                shortcut={shortcutHint}
            />
        );
    return (
        <span
            className={cn(
                'session-indicators hidden flex-none items-center justify-end has-[>:not(.hidden)]:flex',
                className,
            )}
        >
            <SessionStatusIndicator
                fallback={!renaming && <SessionPullRequestIndicator pullRequest={pullRequest} />}
                session={session}
                terminal={terminal}
            />
        </span>
    );
}
