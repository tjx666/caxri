import { ChevronDown, ChevronRight } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { focusDisclosureRow } from '../primary-sidebar-focus';
import { toggleSessionChildrenCollapsed } from './session-children-collapse';

interface SessionChildrenDisclosureProperties {
    isCollapsed: boolean;
    sessionId: string;
    /**
     * The Session's display title, for the chevron's accessible name.
     */
    title: string;
}

/**
 * The chevron that folds a host Session's child rows (its subagents and the Sessions it delegated), issue #4065. It
 * sits in the indent gutter left of the Agent icon, the column the group heading's own chevron uses, so a host row
 * keeps its icon and title where every other row has them. Always shown while folded, since it is then the only cue
 * that rows are hidden; shown on hover while open, so an ordinary list does not grow a column of chevrons.
 *
 * Like the group heading's chevron it is a pointer target only (`tabIndex={-1}`) that hands focus back to its row; the
 * keyboard folds and unfolds with Left and Right on the row itself.
 */
export function SessionChildrenDisclosure({
    isCollapsed,
    sessionId,
    title,
}: SessionChildrenDisclosureProperties) {
    const { t } = useTranslation();
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
                    'session-children-disclosure absolute top-0 -left-4 z-10 grid h-7 w-4 cursor-pointer place-items-center border-0 bg-transparent p-0 text-muted hover:text-foreground',
                    !isCollapsed &&
                        'opacity-0 group-hover/session-row:opacity-100 focus-visible:opacity-100',
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
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
        </Tooltip>
    );
}

/**
 * How many child rows a folded host hides, after its title. A warning dot joins the number when one of the hidden
 * Sessions waits on the user or failed, the same dot a collapsed Project heading shows, so folding never hides work
 * that needs a person. `aria-hidden` because the row's `aria-expanded` already tells assistive tech the rows are
 * folded, and the rows themselves are one Right arrow away.
 */
export function SessionChildrenCount({ count, needsYou }: { count: number; needsYou: boolean }) {
    return (
        <span
            aria-hidden="true"
            className="session-children-count flex flex-none items-center gap-1 text-[11px] text-muted tabular-nums"
        >
            {needsYou && <span className="size-1.5 rounded-full bg-warning" />}
            {count}
        </span>
    );
}
