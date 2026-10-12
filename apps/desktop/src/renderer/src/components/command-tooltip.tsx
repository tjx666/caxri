import type { ReactElement } from 'react';

import type { CommandId } from '@caxri/protocol';
import { getCommandDefinition } from '@caxri/protocol';

import { useTranslation } from '../i18n';
import { commandDescription } from '../lib/command-labels';
import { useCommandShortcut } from '../lib/keybindings';
import { Tooltip } from './ui/tooltip';

/**
 * Lives beside the workbench chrome rather than in `components/ui/` because `useCommandShortcut` reaches into the
 * workbench store: keeping it out of the `Tooltip` module is what lets the standalone Process Explorer window use the
 * shared tooltip without pulling the entire workbench state graph into its bundle.
 */
export function CommandTooltip({
    children,
    commandId,
}: {
    children: ReactElement;
    commandId: CommandId;
}) {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut(commandId);
    const command = getCommandDefinition(commandId);
    return (
        <Tooltip content={commandDescription(command, t)} shortcut={shortcut}>
            {children}
        </Tooltip>
    );
}
