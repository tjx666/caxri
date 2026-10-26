import { translate } from '../../i18n';
import { getSessionDocuments, useSessionViewStore } from '../../stores/session-view';
import { describeFailureNotice, isCancelledRequest } from '../../stores/toasts';

/**
 * Remembers which save failure the user has already been told about, per document and reason.
 *
 * Auto save fires on every focus change, so a file that cannot be written (read-only, disk full) would otherwise raise
 * the same toast again each time the user clicks elsewhere. A failure is reported once per (document, reason) until the
 * document saves successfully or the user saves it by hand. A different reason, or a different document, is a new
 * failure and reports normally. Closing or reloading the document also forgets it (see `subscribeSaveFailureCleanup`).
 */
export interface SaveFailureTracker {
    /**
     * Records a failure and returns whether the user should be told. A forced report (a manual save) always shows.
     */
    shouldReport: (documentKey: string, reason: string, options?: { force?: boolean }) => boolean;
    /**
     * Forgets the document's last failure, after a successful save.
     */
    clear: (documentKey: string) => void;
    /**
     * Forgets every failure whose document `isUnsaved` no longer reports as the same unsaved buffer.
     */
    retain: (isUnsaved: (documentKey: string) => boolean) => void;
}

/**
 * The tracker key for a document of a Session.
 */
export function saveFailureKey(sessionId: string, path: string): string {
    return `${sessionId}\u{0}${path}`;
}

export function createSaveFailureTracker(): SaveFailureTracker {
    const reported = new Map<string, string>();
    return {
        shouldReport: (documentKey, reason, options) => {
            const isRepeat = reported.get(documentKey) === reason;
            reported.set(documentKey, reason);
            return options?.force === true || !isRepeat;
        },
        clear: (documentKey) => {
            reported.delete(documentKey);
        },
        retain: (isUnsaved) => {
            for (const documentKey of reported.keys())
                if (!isUnsaved(documentKey)) reported.delete(documentKey);
        },
    };
}

/**
 * Forgets a document's reported failure once its unsaved buffer is gone: the tab closed (the cache evicted it), or a
 * reload from disk replaced it with a clean copy. Otherwise reopening the file and failing again would stay quiet,
 * although the earlier toast is long gone (issue #2419). A buffer kept under an inactive Workbench Root reads as gone
 * too, which only means its next failure reports again.
 */
export function subscribeSaveFailureCleanup(tracker: SaveFailureTracker): () => void {
    const isUnsaved = (documentKey: string): boolean => {
        const separator = documentKey.indexOf('\u{0}');
        const sessionId = documentKey.slice(0, separator);
        const path = documentKey.slice(separator + 1);
        return getSessionDocuments(sessionId)?.[path]?.dirty === true;
    };
    return useSessionViewStore.subscribe(() => tracker.retain(isUnsaved));
}

/**
 * The failure toast title, naming the file so two failing files read as two failures.
 */
export function saveFailedLabel(path: string): string {
    return translate('editor.document.saveFailedFile', {
        name: path.split(/[\\/]/u).at(-1) ?? path,
    });
}

/**
 * Runs `write` and rethrows a failure only when the user should hear about it. A repeated automatic failure resolves to
 * `undefined` instead, so the caller treats the document as unsaved without raising a second toast.
 */
export async function writeReportingNewFailures<Result>(
    tracker: SaveFailureTracker,
    documentKey: string,
    isAutomatic: boolean,
    write: () => Promise<Result>,
): Promise<Result | undefined> {
    let result: Result;
    try {
        result = await write();
    } catch (error) {
        if (isCancelledRequest(error)) throw error;
        const reason = describeFailureNotice(error, '').message;
        if (!tracker.shouldReport(documentKey, reason, { force: !isAutomatic })) return undefined;
        throw error;
    }
    tracker.clear(documentKey);
    return result;
}
