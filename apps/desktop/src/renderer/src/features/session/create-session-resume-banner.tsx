import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useDialogStore } from '../../stores/dialogs';
import { cancelPendingSession, resumePendingSession } from './session-creation-commands';

/**
 * Floats above the Workbench while the Agent dialog is hidden for Settings, so the user can always get back to the
 * pending Session (or abandon it, which revokes the folder grant) without remembering where they left off.
 */
export function CreateSessionResumeBanner() {
    const { t } = useTranslation();
    const isSuspended = useDialogStore(
        (state) => state.isPendingSuspended && Boolean(state.pendingRoot ?? state.pendingProjectId),
    );
    if (!isSuspended) return null;
    return (
        <div
            className="fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-elevated py-2 pr-2 pl-4 text-[13px] shadow-[0_8px_24px_var(--shadow)]"
            role="status"
        >
            <span>{t('session.createDialog.suspended')}</span>
            <Button size="sm" variant="ghost" onClick={cancelPendingSession}>
                {t('session.createDialog.cancel')}
            </Button>
            <Button size="sm" variant="secondary" onClick={resumePendingSession}>
                {t('session.createDialog.resume')}
            </Button>
        </div>
    );
}
