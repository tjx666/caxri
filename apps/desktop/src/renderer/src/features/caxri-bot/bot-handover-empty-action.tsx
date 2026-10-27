import { HandHelping } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { openBotHandover } from './bot-handover-store';

/**
 * The secondary recovery an empty Caxri Bot surface offers: give Caxri Bot work the user already started. The same
 * dialog as the title bar's Hand Over… button, placed where a first-time user looks when the board is empty.
 */
export function BotHandoverEmptyAction() {
    const { t } = useTranslation();
    return (
        <Button
            size="sm"
            variant="secondary"
            className="bot-handover-empty-action"
            onClick={() => openBotHandover()}
        >
            <HandHelping size={13} />
            {t('caxriBot.handover.openEllipsis')}
        </Button>
    );
}
