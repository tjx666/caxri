import { ChevronRight } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { cn } from '../../../lib/utilities';
import { focusDisclosureRow } from '../primary-sidebar-focus';
import type { SessionChildRows } from './hooks/use-session-child-rows';
import { toggleSessionChildrenCollapsed } from './session-children-collapse';

interface SessionChildrenDisclosureProperties {
    /**
     * True while the row is being renamed: the inline editor owns the row then.
     */
    isRenaming: boolean;
    rows: SessionChildRows;
    sessionId: string;
    /**
     * The Session's display title, for the chevron's accessible name.
     */
    title: string;
}

/**
 * The chevron that folds a host Session's child rows (its subagents and the Sessions it delegated), issues #4065 and
 * #4092. It lies over the host's Agent icon and appears only under pointer hover, while the icon fades out beneath it
 * (Notion's page-icon toggle): a host row then needs no gutter column of its own, which read as one more group heading
 * beside the Pinned and Project chevrons. The folded state is told by `SessionChildrenCount`, not by this chevron.
 *
 * Like the group heading's chevron it is a pointer target only (`tabIndex={-1}`) that hands focus back to its row; the
 * keyboard folds and unfolds with Left and Right on the row itself.
 */
export function SessionChildrenDisclosure({
    isRenaming,
    rows,
    sessionId,
    title,
}: SessionChildrenDisclosureProperties) {
    const { t } = useTranslation();
    if (isRenaming || rows.isExpanded === undefined) return null;
    const isCollapsed = rows.isCollapsed;
    const label = t(
        isCollapsed
            ? 'primarySidebar.sessionChildren.expand'
            : 'primarySidebar.sessionChildren.collapse',
        { title },
    );
    return (
        <Tooltip content={label}>
            <button
                aria-expanded={!isCollapsed}
                aria-label={label}
                className={cn(
                    // Centered on the 14px icon at the row's 8px inset: x 4 to 26, the full 28px row height.
                    'session-children-disclosure absolute top-0 left-1 z-10 grid h-7 w-5.5 cursor-pointer place-items-center border-0 bg-transparent p-0 text-muted opacity-0 transition-opacity group-hover/session-row:opacity-100 hover:text-foreground focus-visible:opacity-100',
                )}
                data-session-children={isCollapsed ? 'collapsed' : 'expanded'}
                tabIndex={-1}
                type="button"
                onClick={(event) => {
                    event.stopPropagation();
                    toggleSessionChildrenCollapsed(sessionId);
                    focusDisclosureRow(event.currentTarget);
                }}
            >
                <ChevronRight
                    aria-hidden="true"
                    className={cn('transition-transform', !isCollapsed && 'rotate-90')}
                    size={14}
                />
            </button>
        </Tooltip>
    );
}

/**
 * How many child rows a folded host hides, as a quiet pill just left of the row's status slot. A warning dot joins the
 * number when one of the hidden delegated Sessions waits on the user or failed, the same dot a collapsed Project
 * heading shows, so folding never hides a delegated Session that needs a person. A background subagent row adds to the
 * count only: it cannot wait on the user, and its failure reaches the host Agent, which reports it in the host's own
 * status. Nothing else crosses the fold: a running or finished child would only repeat the spinner or pull request
 * glyph the host shows for itself beside it. An expanded host shows no pill, since its rows are on screen. Like the
 * other trailing glyphs it gives way to Pin and Archive under pointer hover. `aria-hidden` because the row's
 * `aria-expanded` already tells assistive tech the rows are folded, and the rows themselves are one Right arrow away.
 */
export function SessionChildrenCount({ rows }: { rows: SessionChildRows }) {
    if (!rows.isCollapsed) return null;
    return (
        <span
            aria-hidden="true"
            className="session-children-count flex h-4.5 flex-none items-center gap-1 rounded-full bg-muted/15 px-1.5 text-[11px] leading-none text-muted tabular-nums group-hover/session-row:hidden"
        >
            {rows.needsYou && <span className="size-1.5 rounded-full bg-warning" />}
            {rows.count}
        </span>
    );
}

/**
 * A Session row's Agent mark: a plain brand-color glyph whose color tells Agents apart; lifecycle lives at the row's
 * right edge. On a host row it fades out under pointer hover, where `SessionChildrenDisclosure` shows its chevron in
 * the same spot, so folding needs no gutter column of its own. A nested row's mark is 12px, one step below its host's.
 */
export function SessionRowAgentIcon({
    identity,
    isRenaming,
    nested = false,
    rows,
}: {
    identity: string;
    /**
     * True while the row is being renamed: the disclosure is hidden then, so the icon stays.
     */
    isRenaming: boolean;
    nested?: boolean;
    rows: SessionChildRows;
}) {
    // Only a host row has a disclosure (`isExpanded` is defined) to take the icon's place.
    const isYieldsToDisclosure = rows.isExpanded !== undefined && !isRenaming;
    return (
        <span
            className={cn(
                'session-agent-icon flex flex-none transition-opacity',
                isYieldsToDisclosure && 'group-hover/session-row:opacity-0',
            )}
        >
            <AgentIdentityIcon identity={identity} size={nested ? 12 : 14} />
        </span>
    );
}
