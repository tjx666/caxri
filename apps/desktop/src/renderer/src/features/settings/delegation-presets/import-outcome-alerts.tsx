import { Alert } from '../../../components/ui/alert';
import { useTranslation } from '../../../i18n';
import { importIssueLines } from './delegation-import-model';
import type { DelegationImportState } from './use-delegation-import';

type OpenState = Extract<DelegationImportState, { phase: 'open' }>;

/**
 * The warning or error an outcome carries, if any: a refreshed preview, a rejected file with its issues, an unreadable
 * file, or a failed request.
 */
export function ImportOutcomeAlerts({ outcome }: { outcome: OpenState['outcome'] }) {
    const { t } = useTranslation();
    switch (outcome.kind) {
        case 'ready': {
            return outcome.isRefreshed ? (
                <Alert variant="warning">{t('settings.delegationPresets.refreshed')}</Alert>
            ) : null;
        }
        case 'rejected': {
            return (
                <Alert variant="danger" className="flex flex-col gap-1">
                    <span>{t('settings.delegationPresets.invalid')}</span>
                    {importIssueLines(outcome.issues, t).map((line, index) => (
                        <span key={`${line}-${index}`} className="font-mono">
                            {line}
                        </span>
                    ))}
                </Alert>
            );
        }
        case 'unreadable': {
            return <Alert variant="danger">{t('settings.delegationPresets.unreadable')}</Alert>;
        }
        case 'failed': {
            return <Alert variant="danger">{t('settings.delegationPresets.failed')}</Alert>;
        }
        default: {
            return null;
        }
    }
}
