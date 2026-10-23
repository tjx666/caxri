import type { AppSettings } from '@caxri/protocol';
import {
    defaultAppSettings,
    isUntitledEditorTabPath,
    parseExternalEditorTab,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import type { EditorDocument } from '@desktop-shared/editor-state';

import { caxri } from '../../lib/caxri';
import { getBootstrap } from '../../stores/selectors';
import { isSavableEditorPath } from './document-write-commands';
import { untitledDisplayName } from './untitled/names';

type AutoSaveMode = AppSettings['files.autoSave'];

export function autoSaveMode(): AutoSaveMode {
    return getBootstrap()?.settings['files.autoSave'] ?? defaultAppSettings['files.autoSave'];
}

/**
 * Whether leaving an editor should save its document: only a changed, writable, savable buffer, so leaving a clean or
 * read-only document never writes the file back and resets its modification time. An untitled buffer is never
 * auto-saved, as in VS Code: it has no file, and a Save As dialog on every focus change would be unusable.
 */
export function shouldAutoSaveDocument(
    mode: AutoSaveMode,
    path: string,
    document: EditorDocument | undefined,
): boolean {
    return (
        mode === 'onFocusChange' &&
        document?.dirty === true &&
        document.readOnly !== true &&
        !isUntitledEditorTabPath(path) &&
        isSavableEditorPath(path)
    );
}

export function isAutoSaveOnFocusChange(): boolean {
    return autoSaveMode() === 'onFocusChange';
}

/**
 * How closing a dirty editor resolves. Under `onFocusChange` it saves without asking, as VS Code does: the native "Do
 * you want to save…" sheet takes focus from the editor itself, so the buffer would be saved while the sheet is still
 * open and "Don't Save" could no longer keep the file unchanged. An untitled buffer always asks, because saving it
 * means choosing a file and Don't Save is the common answer for scratch text.
 */
export async function resolveDirtyEditorClose(
    path: string,
    content = '',
): Promise<'save' | 'discard' | 'cancel'> {
    const isUntitled = isUntitledEditorTabPath(path);
    if (!isUntitled && isAutoSaveOnFocusChange()) return 'save';
    const { choice } = await caxri.request('editor.confirmDiscard', {
        name: isUntitled
            ? untitledDisplayName(path, content)
            : (parseExternalEditorTab(path)?.name ?? pathBasename(path)),
    });
    return choice;
}
