import type { LucideIcon } from 'lucide-react';
import {
    CheckCheck,
    ChevronDown,
    ChevronRight,
    Hand,
    Hourglass,
    Moon,
    Pin,
    TriangleAlert,
    Zap,
} from 'lucide-react';

import type {
    AgentActivityGroup,
    AgentActivityGroupId,
    agentActivityHeadingPresentation,
} from './agent-activity-rows';

/**
 * A glyph before each group heading, so the eye finds a group by shape before it reads the label; Paseo's status list
 * does the same. Every shape is deliberately different from the circle-family glyphs the rows use: a heading icon names
 * the section, and repeating the row glyph above its own rows would say the same thing twice. They stay in the
 * heading's muted tone, because color in this list is reserved for rows that want the user.
 *
 * "Needs attention" is a raised hand rather than a bell: the status bar's notification center already owns the bell,
 * and a Session in this group is waiting for the user's turn, not announcing an app notification.
 */
const GROUP_ICONS: Record<AgentActivityGroupId, LucideIcon> = {
    pinned: Pin,
    attention: Hand,
    failed: TriangleAlert,
    finished: CheckCheck,
    idle: Moon,
    waiting: Hourglass,
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
    onToggle,
}: {
    expanded: boolean;
    group: AgentActivityGroup;
    heading: ReturnType<typeof agentActivityHeadingPresentation>;
    roving: boolean;
    onFocus: () => void;
    onToggle: () => void;
}) {
    const Chevron = expanded ? ChevronDown : ChevronRight;
    return (
        <div
            aria-expanded={expanded}
            aria-level={1}
            aria-selected={false}
            className="agent-activity-heading group/activity-heading relative mt-3 flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-foreground select-none before:pointer-events-none before:absolute before:inset-x-2 before:-top-2 before:h-px before:bg-border first:mt-0 first:before:hidden hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
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
            {heading.count !== undefined && (
                <span aria-hidden="true" className="font-normal text-muted tabular-nums">
                    {heading.count}
                </span>
            )}
            <span className="sr-only">{heading.summary}</span>
            <Chevron
                aria-hidden="true"
                className="ml-auto flex-none text-muted opacity-0 transition-opacity group-hover/activity-heading:opacity-100 group-focus-visible/activity-heading:opacity-100 group-data-[expanded=false]/activity-heading:opacity-100"
                size={12}
            />
        </div>
    );
}
