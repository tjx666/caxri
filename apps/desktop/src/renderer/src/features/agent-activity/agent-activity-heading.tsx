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
    return <Icon aria-hidden="true" className="agent-activity-heading-icon flex-none" size={12} />;
}

const PINNED_DISCLOSURE_KEYS: ReadonlySet<string> = new Set([
    'ArrowLeft',
    'ArrowRight',
    'Enter',
    ' ',
]);

/**
 * One group heading in the Activity tree.
 *
 * A status heading is a `treeitem` because everything inside `role="tree"` has to be one, but an `aria-disabled` one
 * with no Tab stop: those groups are derived from Agent state and cannot be collapsed, so there is no action to land
 * focus on. Arrow keys step over it, the same way DESIGN.md has them step over a branch placeholder.
 *
 * The Pinned heading (`pinnedDisclosure`) is the one focus stop: it collapses, like the Project tree's Pinned heading,
 * so Enter, Space, and Left/Right toggle it the way a tree branch does.
 */
export function AgentActivityHeading({
    group,
    heading,
    pinnedDisclosure,
}: {
    group: AgentActivityGroup;
    heading: ReturnType<typeof agentActivityHeadingPresentation>;
    pinnedDisclosure:
        | { expanded: boolean; onFocus: () => void; onToggle: () => void; roving: boolean }
        | undefined;
}) {
    const content = (
        <>
            <AgentActivityGroupIcon groupId={group.id} />
            <span>{heading.label}</span>
            {heading.count !== undefined && (
                <span aria-hidden="true" className="tabular-nums">
                    {heading.count}
                </span>
            )}
            <span className="sr-only">{heading.summary}</span>
        </>
    );
    if (!pinnedDisclosure)
        return (
            <div
                aria-disabled="true"
                aria-level={1}
                className="agent-activity-heading mt-2 flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium text-muted first:mt-0"
                data-activity-group={group.id}
                data-row-id={group.id}
                role="treeitem"
            >
                {content}
            </div>
        );
    const { expanded, onFocus, onToggle, roving } = pinnedDisclosure;
    const Chevron = expanded ? ChevronDown : ChevronRight;
    return (
        <div
            aria-expanded={expanded}
            aria-level={1}
            aria-selected={false}
            className="agent-activity-heading agent-activity-pinned-heading mt-2 flex cursor-pointer items-center gap-1.5 rounded-md px-2 pb-1 text-[11px] font-medium text-muted first:mt-0 hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
            data-activity-group={group.id}
            data-row-id={group.id}
            role="treeitem"
            tabIndex={roving ? 0 : -1}
            onClick={onToggle}
            onFocus={onFocus}
            onKeyDown={(event) => {
                if (!PINNED_DISCLOSURE_KEYS.has(event.key)) return;
                if (expanded && event.key === 'ArrowRight') return;
                if (!expanded && event.key === 'ArrowLeft') return;
                event.preventDefault();
                onToggle();
            }}
        >
            {content}
            <Chevron aria-hidden="true" className="flex-none" size={12} />
        </div>
    );
}
