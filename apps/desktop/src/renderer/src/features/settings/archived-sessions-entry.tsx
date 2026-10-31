import { Archive } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { setArchivedSessionsOpen } from '../../stores/dialogs';

/**
 * Opens the archived Sessions manager. The manager is its own dialog, floating over the Settings page; the page is not
 * a modal, so there is no modal layer to close first.
 */
export function ArchivedSessionsEntry() {
    const { t } = useTranslation();
    return (
        <Button
            className="archived-sessions-entry w-44 flex-none"
            variant="secondary"
            onClick={() => setArchivedSessionsOpen(true)}
        >
            <Archive aria-hidden="true" size={14} />
            {t('settings.row.archivedSessions.manage')}
        </Button>
    );
}
