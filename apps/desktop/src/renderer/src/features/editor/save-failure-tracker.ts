import { translate } from '../../i18n';
import { describeFailureNotice, isCancelledRequest } from '../../stores/toasts';

/**
 * Remembers which save failure the user has already been told about, per document and reason.
 *
 * Auto save fires on every focus change, so a file that cannot be written (read-only, disk full) would otherwise raise
 * the same toast again each time the user clicks elsewhere. A failure is reported once per (document, reason) until the
 * document saves successfully or the user saves it by hand. A different reason, or a different document, is a new
 * failure and reports normally.
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
    };
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
