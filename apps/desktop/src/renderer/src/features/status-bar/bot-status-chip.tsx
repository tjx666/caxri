import { Bot } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { useTranslation } from '../../i18n';
import { useCaxriQuery } from '../../queries/client';
import { botStatusChipCopy } from './bot-status-label';
import { StatusItem } from './status-item';

/**
 * Shows that Caxri Bot keeps running after its window closes. Muted like the other mode chips (DESIGN.md status bar
 * redline). `state.changed` invalidates the read, so it follows Caxri Bot without polling.
 */
export function BotStatusChip() {
    const { t } = useTranslation();
    const { data } = useCaxriQuery('bot.status', {});
    const copy = data && botStatusChipCopy(data.state, t);
    if (!copy) return null;
    return (
        <StatusItem
            icon={<Bot />}
            ariaLabel={copy.description}
            title={copy.description}
            className="bot-status-chip text-muted"
            onClick={() => executeCommand('caxriBot.open')}
        >
            {copy.text}
        </StatusItem>
    );
}
