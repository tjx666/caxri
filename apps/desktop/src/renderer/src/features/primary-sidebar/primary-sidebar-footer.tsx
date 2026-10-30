import { Archive } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { setArchivedSessionsOpen } from '../../stores/dialogs';

/**
 * The global Archived Sessions entry. The footer row holds nothing else, so the whole row is the button: a short
 * visible label on the left, the count on the right. A glyph-only chip was tried and reverted: it left most of the row
 * dead to clicks and read as a stray control.
 *
 * It reads as one more row of the Session tree above it: the same 28px height, 16px glyph inset (the footer's 8px
 * padding plus the row's, matching the list's), 14px glyph, and `--state-hover` tint as a Session row, so its icon and
 * label line up with the Sessions. The count keeps the same 16px inset on the right, so the row is symmetric; a hover
 * chevron was dropped because its reserved slot pushed the count 18px further in than the glyph. There is no divider
 * above it: the list's bottom scroll cue marks the edge only while rows are hidden below, so a list that ends above the
 * footer ends cleanly.
 */
export function PrimarySidebarFooter({ archivedCount }: { archivedCount: number }) {
    const { t } = useTranslation();
    return (
        <div className="shrink-0 px-2 pt-1 pb-2">
            <button
                className="archived-sessions-entry flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[12px] text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                type="button"
                aria-label={t('primarySidebar.footer.archivedAriaLabel', { count: archivedCount })}
                onClick={() => setArchivedSessionsOpen(true)}
            >
                <Archive aria-hidden="true" size={14} className="shrink-0" />
                <span aria-hidden="true" className="min-w-0 truncate">
                    {t('primarySidebar.footer.archived')}
                </span>
                <span aria-hidden="true" className="ml-auto text-[11px] tabular-nums">
                    {archivedCount}
                </span>
            </button>
        </div>
    );
}
