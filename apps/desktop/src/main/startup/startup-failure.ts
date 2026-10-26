import { errorMessage, isCaxriError } from '@caxri/protocol';

import type { MainTranslationKey } from '../locale';
import { translateMain } from '../locale';

/**
 * Closed set of causes shown to the user and recorded in the startup log, so a failed launch is explainable without
 * reading free-form error text.
 */
export type StartupFailureReason = 'crashed-on-boot' | 'database' | 'timeout' | 'unknown';

/**
 * Buckets a Server start error into a {@link StartupFailureReason}. The supervisor reports plain messages rather than
 * structured causes, so this matches on the error code and message text and falls back to `unknown`.
 */
export function classifyStartupFailure(error: unknown): StartupFailureReason {
    const message = errorMessage(error, '');
    if ((isCaxriError(error) && error.code === 'TIMEOUT') || /timed?[ -]?out/iu.test(message))
        return 'timeout';
    if (/sqlite|database|migration|schema/iu.test(message)) return 'database';
    if (/exit(?:ed)?\b|crash|terminated|signal|spawn|ECONNREFUSED/iu.test(message))
        return 'crashed-on-boot';
    return 'unknown';
}

const DETAIL_KEYS: Record<StartupFailureReason, MainTranslationKey> = {
    'crashed-on-boot': 'desktop.startupFailed.detail.crashedOnBoot',
    'database': 'desktop.startupFailed.detail.database',
    'timeout': 'desktop.startupFailed.detail.timeout',
    'unknown': 'desktop.startupFailed.detail.unknown',
};

/**
 * What the user chose in a recovery dialog. `reveal` keeps the dialog open afterwards so the user can still decide.
 */
export type RecoveryChoice = 'quit' | 'retry' | 'reveal';

interface RecoveryDialogOptions {
    buttons: string[];
    cancelId: number;
    defaultId: number;
    detail: string;
    message: string;
    title: string;
    type: 'error';
}

/**
 * Dialog for a Server start failure: Try Again, Reveal Logs in Finder, Quit.
 */
export function startupFailureDialog(reason: StartupFailureReason): RecoveryDialogOptions {
    return {
        type: 'error',
        title: translateMain('desktop.startupFailed.title'),
        message: translateMain('desktop.startupFailed.message'),
        detail: translateMain(DETAIL_KEYS[reason]),
        buttons: [
            translateMain('desktop.startupFailed.retry'),
            translateMain('desktop.startupFailed.revealLogs'),
            translateMain('desktop.startupFailed.quit'),
        ],
        defaultId: 0,
        cancelId: 2,
    };
}

/**
 * Maps a button index of {@link startupFailureDialog} to its action.
 */
export function startupFailureChoice(response: number): RecoveryChoice {
    if (response === 0) return 'retry';
    if (response === 1) return 'reveal';
    return 'quit';
}

/**
 * Dialog for a Server left behind by another build: Reveal Data Folder, Quit. Retrying cannot help, so it is not
 * offered.
 */
export function incompatibleServerDialog(): RecoveryDialogOptions {
    return {
        type: 'error',
        title: translateMain('desktop.reset.title'),
        message: translateMain('desktop.reset.message'),
        detail: translateMain('desktop.reset.detail'),
        buttons: [translateMain('desktop.reset.revealData'), translateMain('desktop.reset.quit')],
        defaultId: 0,
        cancelId: 1,
    };
}

/**
 * Maps a button index of {@link incompatibleServerDialog} to its action.
 */
export function incompatibleServerChoice(response: number): RecoveryChoice {
    return response === 0 ? 'reveal' : 'quit';
}
