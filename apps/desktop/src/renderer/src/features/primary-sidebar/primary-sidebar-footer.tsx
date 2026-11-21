import { Archive, Settings } from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { openSettings, setArchivedSessionsOpen } from '../../stores/dialogs';

const footerButton =
    'flex h-7 cursor-pointer items-center rounded-md border-0 bg-transparent text-[12px] text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none';

/**
 * The PrimarySidebar's footer row: Settings on the left, Archived Sessions as a glyph button on the right, as Maka's
 * sidebar pairs them. Settings takes the rest of the row, so the row stays one wide click target with a visible label
 * (a glyph-only Archived chip alone left most of the row dead to clicks); Archived is a secondary destination, so it
 * shows no label and no count. The count is not something the user acts on, so it lives only in the tooltip and the
 * accessible name.
 *
 * It reads as one more row of the Session tree above it: the same 28px height, 16px glyph inset (the footer's 8px
 * padding plus the row's, matching the list's), 14px glyph, and `--state-hover` tint as a Session row, so its icon and
 * label line up with the Sessions. The Archived button is a 28px square, so its glyph keeps the same 16px inset on the
 * right and the row is symmetric. There is no divider above it: the list's bottom scroll cue marks the edge only while
 * rows are hidden below, so a list that ends above the footer ends cleanly.
 */
export function PrimarySidebarFooter({ archivedCount }: { archivedCount: number }) {
    const { t } = useTranslation();
    const archivedLabel = t('primarySidebar.footer.archivedAriaLabel', { count: archivedCount });
    return (
        <div className="flex shrink-0 items-center gap-1 px-2 pt-1 pb-2">
            <CommandTooltip commandId="settings.open">
                <button
                    className={`${footerButton} min-w-0 flex-1 gap-2 px-2 text-left`}
                    type="button"
                    onClick={() => openSettings()}
                >
                    <Settings aria-hidden="true" size={14} className="shrink-0" />
                    <span className="min-w-0 truncate">{t('settings.page.heading')}</span>
                </button>
            </CommandTooltip>
            <Tooltip content={archivedLabel}>
                <button
                    className={`archived-sessions-entry ${footerButton} w-7 shrink-0 justify-center`}
                    type="button"
                    aria-label={archivedLabel}
                    onClick={() => setArchivedSessionsOpen(true)}
                >
                    <Archive aria-hidden="true" size={14} />
                </button>
            </Tooltip>
        </div>
    );
}
