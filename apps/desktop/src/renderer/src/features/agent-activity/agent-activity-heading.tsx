import type { LucideIcon } from 'lucide-react';
import { CheckCheck, ChevronDown, ChevronRight, Hand, Moon, Pin, Zap } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { sessionRowActionButton } from '../primary-sidebar/session-row-actions';
import type {
    AgentActivityGroup,
    AgentActivityGroupId,
    agentActivityHeadingPresentation,
} from './agent-activity-rows';

/**
 * A glyph before each group heading, so the eye finds a group by shape before it reads the label; Paseo's status list
 * does the same. Rows carry no state glyph of their own, so the heading icon is the only shape naming the section. They
 * stay in the heading's muted tone, because color in this list is reserved for rows that want the user.
 *
 * "Needs attention" is a raised hand rather than a bell: the status bar's notification center already owns the bell,
 * and a Session in this group is waiting for the user's turn, not announcing an app notification.
 */
const GROUP_ICONS: Record<AgentActivityGroupId, LucideIcon> = {
    pinned: Pin,
    attention: Hand,
    idle: Moon,
    working: Zap,
};
function AgentActivityGroupIcon({ groupId }: { groupId: AgentActivityGroupId }) {
    const Icon = GROUP_ICONS[groupId];
    return (
        <Icon
            aria-hidden="true"
            className="agent-activity-heading-icon flex-none text-muted"
            size={12}
        />
    );
}

const DISCLOSURE_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'Enter', ' ']);

/**
 * One group heading in the Activity tree: a disclosure, like the Project tree's Project and Pinned headings, so Enter,
 * Space, and Left/Right toggle it the way a tree branch does. A collapsed group still shows its count, so nothing reads
 * as gone.
 *
 * Every heading after the first draws a hairline above itself and gains extra top space. Without it the groups ran
 * together into one long list, because a heading is a single muted line about as tall as the Session rows' own second
 * line; the line marks where one state ends without spending a row on it (Paseo spaces its status groups the same
 * way).
 */
export function AgentActivityHeading({
    expanded,
    group,
    heading,
    roving,
    onFocus,
    onMarkAllDone,
    onToggle,
}: {
    expanded: boolean;
    group: AgentActivityGroup;
    heading: ReturnType<typeof agentActivityHeadingPresentation>;
    roving: boolean;
    onFocus: () => void;
    /**
     * Present only on a non-empty Needs attention heading: shows the hover "Mark All as Done" action.
     */
    onMarkAllDone?: () => void;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    const Chevron = expanded ? ChevronDown : ChevronRight;
    // A collapsed group with rows hides them, so its count becomes a filled badge the eye finds; an open group keeps the
    // quiet muted number.
    const isCollapsedWithRows = !expanded && heading.count !== undefined && heading.count > 0;
    return (
        <div
            aria-expanded={expanded}
            aria-level={1}
            aria-selected={false}
            className="agent-activity-heading group/activity-heading relative mt-6 flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-foreground select-none before:pointer-events-none before:absolute before:inset-x-2 before:-top-3.5 before:h-px before:bg-border first:mt-0 first:before:hidden hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
            data-activity-group={group.id}
            data-row-id={group.id}
            data-expanded={expanded}
            role="treeitem"
            tabIndex={roving ? 0 : -1}
            onClick={onToggle}
            onFocus={onFocus}
            onKeyDown={(event) => {
                if (!DISCLOSURE_KEYS.has(event.key)) return;
                if (expanded && event.key === 'ArrowRight') return;
                if (!expanded && event.key === 'ArrowLeft') return;
                event.preventDefault();
                onToggle();
            }}
        >
            <AgentActivityGroupIcon groupId={group.id} />
            <span className="truncate">{heading.label}</span>
            {/* aria-hidden is safe: `heading.summary` (sr-only below) already carries the same count. */}
            {heading.count !== undefined && (
                <span
                    aria-hidden="true"
                    className={
                        isCollapsedWithRows
                            ? 'rounded-full bg-badge px-1.5 text-[11px] leading-4 font-semibold text-badge-foreground tabular-nums'
                            : 'font-normal text-muted tabular-nums'
                    }
                >
                    {heading.count}
                </span>
            )}
            <span className="sr-only">
                {isCollapsedWithRows
                    ? t('agentActivity.heading.collapsed', { summary: heading.summary })
                    : heading.summary}
            </span>
            {onMarkAllDone && (
                // Hover-only like the row actions; the keyboard and the Command Palette reach the same action through
                // `session.markAllAttentionDone`, so the button stays out of the tree's single Tab stop.
                <Tooltip content={t('agentActivity.markAllDone.action')}>
                    <button
                        aria-label={t('agentActivity.markAllDone.action')}
                        className={cn(
                            sessionRowActionButton,
                            'agent-activity-mark-all-done ml-auto flex-none opacity-0 transition-opacity group-hover/activity-heading:opacity-100 group-focus-visible/activity-heading:opacity-100',
                        )}
                        tabIndex={-1}
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onMarkAllDone();
                        }}
                    >
                        <CheckCheck aria-hidden="true" size={12} />
                    </button>
                </Tooltip>
            )}
            <Chevron
                aria-hidden="true"
                className={cn(
                    'flex-none text-muted opacity-0 transition-opacity group-hover/activity-heading:opacity-100 group-focus-visible/activity-heading:opacity-100 group-data-[expanded=false]/activity-heading:opacity-100',
                    !onMarkAllDone && 'ml-auto',
                )}
                size={12}
            />
        </div>
    );
}
