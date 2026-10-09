import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { copyFilePath } from '../../lib/copy-file-path';
import {
    openExternalDocumentInTerminal,
    openExternalDocumentWithDefaultApp,
    openFileInTerminal,
    openFileWithDefaultApp,
    revealExternalDocument,
    revealFile,
} from '../../lib/desktop-file-actions';
import { parentDirectoryPath } from '../../lib/file-path';
import { readCommandShortcut } from '../../lib/keybindings';
import { openFilePreview } from '../preview/preview-commands';
import type {
    DocumentTabDesktopTarget,
    DocumentTabPathResolution,
} from './document-tab-path-actions';
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
    externalDocumentId,
    previewPath,
}: {
    resolution?: DocumentTabPathResolution;
    unavailableReason: string;
    externalDocumentId?: string;
    /**
     * The file a preview of this tab would show, when a previewer claims it. Absent for every other tab, which hides
     * the item instead of disabling it: "cannot preview a `.ts` file" is not a state worth explaining.
     */
    previewPath?: string;
}): ContextMenuEntries {
    const desktop = documentTabDesktopActionState(resolution, {
        externalDocumentId,
        unavailableReason,
    });
    const target = desktop.target;
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
            disabled: !target,
            disabledReason: desktop.disabledReason,
            onSelect: () => target && openWithDefaultApp(target),
        },
        {
            label: 'Reveal in Finder',
            disabled: !target,
            disabledReason: desktop.disabledReason,
            onSelect: () => target && reveal(target),
        },
        {
            label: 'Open in Terminal',
            disabled: !target,
            disabledReason: desktop.disabledReason,
            onSelect: () => target && openInTerminal(target),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Copy Path',
            disabled: !resolution,
            disabledReason: unavailableReason,
            onSelect: () => resolution && copyFilePath(resolution.absolutePath),
        },
        !externalDocumentId && {
            label: 'Copy Relative Path',
            disabled: !resolution?.relativeRoot,
            disabledReason: unavailableReason,
            onSelect: () =>
                resolution?.relativeRoot &&
                copyFilePath(resolution.absolutePath, resolution.relativeRoot),
        },
    ];
}

function openWithDefaultApp(target: DocumentTabDesktopTarget) {
    return target.kind === 'external'
        ? openExternalDocumentWithDefaultApp(target.documentId)
        : openFileWithDefaultApp(target.path);
}

function reveal(target: DocumentTabDesktopTarget) {
    return target.kind === 'external'
        ? revealExternalDocument(target.documentId)
        : revealFile(target.path);
}

function openInTerminal(target: DocumentTabDesktopTarget) {
    return target.kind === 'external'
        ? openExternalDocumentInTerminal(target.documentId)
        : openFileInTerminal(parentDirectoryPath(target.path));
}
