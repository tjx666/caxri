import { isCaxriError, parseExternalEditorTab } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import {
    openExternalDocumentWithDefaultApp,
    openFileWithDefaultApp,
} from '../../lib/desktop-file-actions';
import { isLocalOnlyAvailable } from '../../stores/environment';

/**
 * The one action a failed document or preview load offers. Retrying only helps when the failure can go away by itself
 * (a missing file that comes back, a busy disk, an interrupted request); a file over a size ceiling or one the viewer
 * cannot parse fails the same way on every attempt, so its honest recovery is the application the operating system
 * registers for it.
 */
export type DocumentLoadRecovery = 'openWithDefaultApp' | 'retry';

const documentLoadRecoveryLabels: Record<DocumentLoadRecovery, TranslationKey> = {
    openWithDefaultApp: 'editor.load.openWithDefaultApp',
    retry: 'common.retry',
};

/**
 * Chooses the recovery from the error's structured code. `CAPACITY` is the code every read ceiling throws (the editor's
 * file limit and each preview asset limit), so no message text is matched.
 */
export function documentReadRecovery(error: unknown): DocumentLoadRecovery {
    return isCaxriError(error) && error.code === 'CAPACITY' ? 'openWithDefaultApp' : 'retry';
}

/**
 * Hands a document tab's file to its default application. An external document is named by the opaque ID Main issued, a
 * Project file by its path, which Server Core re-validates against the Session's Project root.
 */
function openDocumentWithDefaultApp(path: string): void {
    const external = parseExternalEditorTab(path);
    // Fire-and-forget: both helpers report their own failure through `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void (external
        ? openExternalDocumentWithDefaultApp(external.documentId)
        : openFileWithDefaultApp(path));
}

/**
 * The `EditorLoadFailure` action props for a recovery: its label plus what pressing it does. An SSH Host window cannot
 * hand a file on the SSH Host to an application on this Mac, so there the recovery falls back to Retry.
 */
export function documentLoadRecoveryAction(
    recovery: DocumentLoadRecovery,
    path: string,
    retry: () => void,
    t: Translate,
    canOpenLocally = isLocalOnlyAvailable(),
): { actionLabel: string; onAction: () => void } {
    const effective = recovery === 'openWithDefaultApp' && !canOpenLocally ? 'retry' : recovery;
    return {
        actionLabel: t(documentLoadRecoveryLabels[effective]),
        onAction: effective === 'retry' ? retry : () => openDocumentWithDefaultApp(path),
    };
}
