import type { DragEvent } from 'react';

import type { TerminalRecord } from '@caxri/protocol';

import { translate } from '../../i18n';
import {
    hasOsFiles,
    hasTerminalDraggedPath,
    isOsFileReferenceRefused,
    projectTerminalInput,
    terminalDragPaths,
    terminalReferencePath,
} from '../../lib/file-drag';
import { pushToast } from '../../stores/toasts';
import { EDITOR_PATH_DRAG_TYPE, resolvePaneDropIntent } from '../workbench/pane-drop-zone';
import { didPasteIntoTerminal } from './terminal-pane-handlers';

/**
 * Whether a drag over a lone Terminal, one with no pane to split or move a tab into, carries something to paste.
 */
export function isTerminalPasteDrag(event: DragEvent): boolean {
    return (
        resolvePaneDropIntent(event.dataTransfer.types, {
            altKey: false,
            isTerminal: true,
            acceptsFileDrop: true,
            hasFilePath: hasTerminalDraggedPath(event),
        }) === 'paste'
    );
}

/**
 * Pastes what a drop carries into a Terminal the caller already accepted it for. A Project root stays absolute; an
 * Editor tab, a Files entry, or files from another application such as Finder are each spelled relative to where the
 * Terminal stands, space-separated in one paste. The default action is cancelled first, so a drop of files that yields
 * nothing still never falls through to the browser. Returns whether the Terminal took the input.
 */
export function didPasteDropIntoTerminal(
    event: DragEvent,
    terminal: Pick<TerminalRecord, 'agentCwd' | 'cwd' | 'id' | 'lastAgentProcessState'>,
    workbenchRoot?: string,
): boolean {
    event.preventDefault();
    const { dataTransfer } = event;
    const input = terminalDropInput(event, terminal, workbenchRoot);
    if (input) return didPasteIntoTerminal(terminal.id, input);
    /**
     * A file promise, such as a Photos item, reaches the page as a `File` with no path on disk, so there is nothing to
     * insert. Say so rather than accept the drop and do nothing. An SSH Host window cites no file from this Mac at all
     * (`isOsFileReferenceRefused`), which gets its own reason.
     */
    if (hasOsFiles(dataTransfer))
        pushToast(
            'warning',
            translate(
                isOsFileReferenceRefused()
                    ? 'terminal.drop.localFileOnSshHost'
                    : 'terminal.drop.noPath',
            ),
        );
    return false;
}

/**
 * The text a drop inserts for a Terminal: a Project root stays absolute; an Editor tab, a Files entry, or files from
 * another application are each spelled relative to where the Terminal stands, space-separated.
 */
function terminalDropInput(
    event: DragEvent,
    terminal: Pick<TerminalRecord, 'agentCwd' | 'cwd' | 'lastAgentProcessState'>,
    workbenchRoot?: string,
): string | undefined {
    const { dataTransfer } = event;
    const projectInput = projectTerminalInput(dataTransfer);
    if (projectInput) return projectInput;
    const editorPath = dataTransfer.getData(EDITOR_PATH_DRAG_TYPE);
    return terminalPathsInput(
        editorPath ? [editorPath] : terminalDragPaths(event),
        terminal,
        workbenchRoot,
    );
}

/**
 * The text that cites `paths` (files or folders), spelled the way a drop of the same paths would be.
 */
function terminalPathsInput(
    paths: readonly string[],
    terminal: Pick<TerminalRecord, 'agentCwd' | 'cwd' | 'lastAgentProcessState'>,
    workbenchRoot: string | undefined,
): string | undefined {
    return paths.length > 0
        ? paths.map((path) => terminalReferencePath(path, terminal, workbenchRoot)).join(' ')
        : undefined;
}
