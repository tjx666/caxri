import type { ReactElement } from 'react';

import type { CommandId } from '@caxri/protocol';

import { Tooltip } from '../../components/ui/tooltip';
import { useCommandShortcut } from '../../lib/keybindings';

/**
 * Icon-only SecondarySidebar tabs surface their title (and shortcut, when one is bound) through a tooltip instead of an
 * inline label. `triggerId` must repeat the tab's own DOM id so Base UI's tooltip store keys to the id the tab
 * renders.
 */
export function ContainerTabTooltip({
    children,
    commandId,
    title,
    triggerId,
}: {
    children: ReactElement;
    commandId: string;
    title: string;
    triggerId: string;
}) {
    // Product extension containers may opt into a stable CommandId so their live binding appears here too.
    const shortcut = useCommandShortcut(commandId as CommandId);
    return (
        <Tooltip content={title} shortcut={shortcut} triggerId={triggerId}>
            {children}
        </Tooltip>
    );
}
