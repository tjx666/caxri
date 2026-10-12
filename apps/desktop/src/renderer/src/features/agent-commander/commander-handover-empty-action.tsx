import { HandHelping } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { openCommanderHandover } from './commander-handover-store';

/**
 * The secondary recovery an empty Commander surface offers: give the Commander work the user already started. The same
 * dialog as the title bar's Hand Over button, placed where a first-time user looks when the board or Inbox is empty.
 */
export function CommanderHandoverEmptyAction() {
    const { t } = useTranslation();
    return (
        <Button
            size="sm"
            variant="secondary"
            className="commander-handover-empty-action"
            onClick={() => openCommanderHandover()}
        >
            <HandHelping size={13} />
            {t('agentCommander.handover.openEllipsis')}
        </Button>
    );
}
