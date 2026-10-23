import type { MouseEvent } from 'react';

import { useContextMenu } from '../../hooks/use-context-menu';
import { translate } from '../../i18n';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { pushToast, tryCommand } from '../../stores/toasts';

/**
 * The right-click menu of a web link or a card that stands for one (a pull request the Agent opened): Open Link and
 * Copy Link, so the address can be pasted elsewhere without opening the browser first.
 */
export function linkContextMenu({
    onCopy,
    onOpen,
}: {
    onCopy: () => void;
    onOpen: () => void;
}): ContextMenuEntries {
    return [
        { label: translate('agentChat.link.open'), onSelect: onOpen },
        { label: translate('agentChat.link.copy'), onSelect: onCopy },
    ];
}

/**
 * Copies a link from its right-click menu with a toast confirming it, since a native menu entry has no check mark to
 * turn into.
 */
function copyLinkFromMenu(url: string): void {
    void tryCommand(translate('agentChat.link.copyFailed'), async () => {
        await navigator.clipboard.writeText(url);
        pushToast('success', translate('agentChat.link.copied'));
    });
}

/**
 * The `onContextMenu` handler that opens {@link linkContextMenu} for `url`. It claims the event, so a link inside a
 * message opens its own menu rather than the message's.
 */
export function useLinkContextMenu(
    url: string,
    onOpen: (url: string) => void,
): (event: MouseEvent) => void {
    return useContextMenu(() =>
        linkContextMenu({ onCopy: () => copyLinkFromMenu(url), onOpen: () => onOpen(url) }),
    );
}
