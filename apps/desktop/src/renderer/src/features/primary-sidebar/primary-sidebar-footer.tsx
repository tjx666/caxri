import { Archive } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { setArchivedSessionsOpen } from '../../stores/dialogs';

/**
 * The global Archived Sessions entry. The footer row holds nothing else, so the whole row is the button: a short
 * visible label on the left, the count on the right. A glyph-only chip was tried and reverted: it left most of the row
 * dead to clicks and read as a stray control.
 */
export function PrimarySidebarFooter({ archivedCount }: { archivedCount: number }) {
    const { t } = useTranslation();
    return (
        <div className="shrink-0 border-t border-border p-1">
            <Button
                className="archived-sessions-entry w-full justify-start gap-1.5 text-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                size="sm"
                variant="ghost"
                aria-label={t('primarySidebar.footer.archivedAriaLabel', { count: archivedCount })}
                onClick={() => setArchivedSessionsOpen(true)}
            >
                <Archive aria-hidden="true" size={13} className="shrink-0" />
                <span aria-hidden="true" className="min-w-0 truncate">
                    {t('primarySidebar.footer.archived')}
                </span>
                <span aria-hidden="true" className="ml-auto tabular-nums">
                    {archivedCount}
                </span>
            </Button>
        </div>
    );
}
