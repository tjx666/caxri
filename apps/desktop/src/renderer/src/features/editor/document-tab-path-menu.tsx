import { ContextMenuItem, ContextMenuSeparator } from '../../components/ui/context-menu';
import { copyFilePath } from '../../lib/copy-file-path';
import {
    openFileInTerminal,
    openFileWithDefaultApp,
    revealFile,
} from '../../lib/desktop-file-actions';
import { parentDirectoryPath } from '../../lib/file-path';
import { useCommandShortcut } from '../../lib/keybindings';
import { openFilePreview } from '../preview/preview-commands';
import type { DocumentTabPathResolution } from './document-tab-path-actions';
import { documentTabDesktopActionState } from './document-tab-path-actions';

function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard; the action reports its own errors via toast
    void promise;
}

/**
 * Renders the same path resolution used by Editor drags. External documents have no Project-relative path, while
 * ordinary files and single-file diffs use the authorized repository root supplied by their caller.
 *
 * The desktop actions are the ones a Files tree row already offers, so one file behaves identically from either menu;
 * `documentTabDesktopActionState` owns when they are available.
 */
export function DocumentTabPathMenu({
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
}) {
    const desktop = documentTabDesktopActionState(resolution, { isExternal, unavailableReason });
    const previewShortcut = useCommandShortcut('editor.openPreview');
    return (
        <>
            {previewPath && (
                <>
                    <ContextMenuItem
                        hint={previewShortcut}
                        onClick={() => openFilePreview(previewPath)}
                    >
                        Open Preview
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                </>
            )}
            <ContextMenuItem
                disabled={!desktop.path}
                disabledReason={desktop.disabledReason}
                onClick={() => {
                    if (desktop.path) discard(openFileWithDefaultApp(desktop.path));
                }}
            >
                Open with Default App
            </ContextMenuItem>
            <ContextMenuItem
                disabled={!desktop.path}
                disabledReason={desktop.disabledReason}
                onClick={() => {
                    if (desktop.path) discard(revealFile(desktop.path));
                }}
            >
                Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem
                disabled={!desktop.path}
                disabledReason={desktop.disabledReason}
                onClick={() => {
                    if (desktop.path)
                        discard(openFileInTerminal(parentDirectoryPath(desktop.path)));
                }}
            >
                Open in Terminal
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
                disabled={!resolution}
                disabledReason={!resolution ? unavailableReason : undefined}
                onClick={() => {
                    if (resolution) discard(copyFilePath(resolution.absolutePath));
                }}
            >
                Copy Path
            </ContextMenuItem>
            {!isExternal && (
                <ContextMenuItem
                    disabled={!resolution?.relativeRoot}
                    disabledReason={!resolution?.relativeRoot ? unavailableReason : undefined}
                    onClick={() => {
                        if (resolution?.relativeRoot)
                            discard(copyFilePath(resolution.absolutePath, resolution.relativeRoot));
                    }}
                >
                    Copy Relative Path
                </ContextMenuItem>
            )}
        </>
    );
}
