import type { MouseEvent } from 'react';

import { useContextMenu } from '../../hooks/use-context-menu';
import { translate } from '../../i18n';
import { writeClipboardText } from '../../lib/clipboard';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { pushToast, tryCommand } from '../../stores/toasts';

/**
 * The right-click menu of a file path cited in Markdown: Open File, Reveal in Finder when the host can show the file on
 * this Mac, and Copy Path, so a path can be located or pasted elsewhere without opening an editor tab first.
 */
export function fileLinkContextMenu({
    onCopy,
    onOpen,
    onReveal,
}: {
    onCopy: () => void;
    onOpen: () => void;
    onReveal?: () => void;
}): ContextMenuEntries {
    return [
        { label: translate('core.markdown.fileMenu.open'), onSelect: onOpen },
        ...(onReveal
            ? [{ label: translate('core.markdown.fileMenu.revealInFinder'), onSelect: onReveal }]
            : []),
        { label: translate('core.markdown.fileMenu.copyPath'), onSelect: onCopy },
    ];
}

/**
 * Copies the path as the message cited it, with a toast confirming it, since a native menu entry has no check mark to
 * turn into.
 */
function copyFilePathFromMenu(file: string): void {
    void tryCommand(translate('core.files.copyPathFailed'), async () => {
        await writeClipboardText(file);
        pushToast('success', translate('core.files.pathCopied'));
    });
}

/**
 * The `onContextMenu` handler that opens {@link fileLinkContextMenu} for `file`. It claims the event, so a path inside a
 * message opens its own menu rather than the message's.
 */
export function useFileLinkContextMenu(
    file: string,
    onOpen: (file: string) => void,
    onReveal: ((file: string) => void) | undefined,
): (event: MouseEvent) => void {
    return useContextMenu(() =>
        fileLinkContextMenu({
            onCopy: () => copyFilePathFromMenu(file),
            onOpen: () => onOpen(file),
            ...(onReveal && { onReveal: () => onReveal(file) }),
        }),
    );
}
