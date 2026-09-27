import type { DragEvent } from 'react';

import type { TerminalRecord } from '@caxri/protocol';

import {
    hasOsFiles,
    hasTerminalDraggedPath,
    projectTerminalInput,
    terminalDragPaths,
    terminalReferencePath,
} from '../../lib/file-drag';
import { pushToast } from '../../stores/toasts';
import { EDITOR_PATH_DRAG_TYPE, resolvePaneDropIntent } from '../workbench/pane-drop-zone';
import { didPasteIntoTerminal } from './terminal-commands';

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
    const projectInput = projectTerminalInput(dataTransfer);
    const editorPath = dataTransfer.getData(EDITOR_PATH_DRAG_TYPE);
    const paths = editorPath ? [editorPath] : terminalDragPaths(event);
    const input =
        projectInput ??
        (paths.length > 0
            ? paths.map((path) => terminalReferencePath(path, terminal, workbenchRoot)).join(' ')
            : undefined);
    if (input) return didPasteIntoTerminal(terminal.id, input);
    /**
     * A file promise, such as a Photos item, reaches the page as a `File` with no path on disk, so there is nothing to
     * insert. Say so rather than accept the drop and do nothing.
     */
    if (hasOsFiles(dataTransfer))
        pushToast(
            'warning',
            'This file has no path on disk to insert. Save it, then drop the saved file.',
        );
    return false;
}
