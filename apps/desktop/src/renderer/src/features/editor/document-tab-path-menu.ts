import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { copyFilePath } from '../../lib/copy-file-path';
import {
    openFileInTerminal,
    openFileWithDefaultApp,
    revealFile,
} from '../../lib/desktop-file-actions';
import { parentDirectoryPath } from '../../lib/file-path';
import { readCommandShortcut } from '../../lib/keybindings';
import { openFilePreview } from '../preview/preview-commands';
import type { DocumentTabPathResolution } from './document-tab-path-actions';
import { documentTabDesktopActionState } from './document-tab-path-actions';

/**
 * Builds the same path resolution used by Editor drags. External documents have no Project-relative path, while
 * ordinary files and single-file diffs use the authorized repository root supplied by their caller.
 *
 * The desktop actions are the ones a Files tree row already offers, so one file behaves identically from either menu;
 * `documentTabDesktopActionState` owns when they are available.
 */
export function documentTabPathMenu({
    resolution,
    unavailableReason,
    isExternal,
    previewPath,
}: {
    resolution?: DocumentTabPathResolution;
    unavailableReason: string;
    isExternal: boolean;
    /**
     * The file a preview of this tab would show, when a previewer claims it. Absent for every other tab, which hides
     * the item instead of disabling it: "cannot preview a `.ts` file" is not a state worth explaining.
     */
    previewPath?: string;
}): ContextMenuEntries {
    const desktop = documentTabDesktopActionState(resolution, { isExternal, unavailableReason });
    const desktopPath = desktop.path;
    return [
        ...(previewPath
            ? [
                  {
                      label: 'Open Preview',
                      shortcut: readCommandShortcut('editor.openPreview'),
                      onSelect: () => openFilePreview(previewPath),
                  },
                  CONTEXT_MENU_SEPARATOR,
              ]
            : []),
        {
            label: 'Open with Default App',
            disabled: !desktopPath,
            disabledReason: desktop.disabledReason,
            onSelect: () => desktopPath && openFileWithDefaultApp(desktopPath),
        },
        {
            label: 'Reveal in Finder',
            disabled: !desktopPath,
            disabledReason: desktop.disabledReason,
            onSelect: () => desktopPath && revealFile(desktopPath),
        },
        {
            label: 'Open in Terminal',
            disabled: !desktopPath,
            disabledReason: desktop.disabledReason,
            onSelect: () => desktopPath && openFileInTerminal(parentDirectoryPath(desktopPath)),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Copy Path',
            disabled: !resolution,
            disabledReason: unavailableReason,
            onSelect: () => resolution && copyFilePath(resolution.absolutePath),
        },
        !isExternal && {
            label: 'Copy Relative Path',
            disabled: !resolution?.relativeRoot,
            disabledReason: unavailableReason,
            onSelect: () =>
                resolution?.relativeRoot &&
                copyFilePath(resolution.absolutePath, resolution.relativeRoot),
        },
    ];
}
