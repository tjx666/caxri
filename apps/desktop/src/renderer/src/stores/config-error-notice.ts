import { translate } from '../i18n';
import { dismissToastsMatching, getToasts, pushToast } from './toasts';

/**
 * The sentence for the current configuration errors, or undefined when there are none. Each error already starts with
 * its file name (`settings.jsonc: ...`), so naming the first one tells the user which file to open. With several, the
 * count comes first so a second broken file is never hidden behind the first.
 */
export function configErrorMessage(errors: readonly string[]): string | undefined {
    if (errors.length === 0) return undefined;
    const first = errors[0];
    if (errors.length === 1) return first;
    return translate('core.configurationErrors.multiple', { count: errors.length, first });
}

/**
 * The text of the notice currently on screen, so a later snapshot with the same errors does not stack a duplicate and a
 * snapshot with none can take it away.
 */
const shown = { message: undefined as string | undefined, shownAt: 0 };

/**
 * How long a manually dismissed notice stays dismissed. The settings file is still broken and defaults are still in
 * use, so the notice returns on a later snapshot, but not on the very next one, which would nag a user who just closed
 * it.
 */
export const CONFIG_ERROR_RESURFACE_MS = 60_000;

function showConfigErrorMessage(message: string, now = Date.now()): void {
    if (shown.message === message) {
        const isVisible = getToasts().some((entry) => entry.title === message);
        if (isVisible || now - shown.shownAt < CONFIG_ERROR_RESURFACE_MS) return;
    }
    if (shown.message !== undefined) {
        const previous = shown.message;
        dismissToastsMatching((title) => title === previous);
    }
    shown.message = message;
    shown.shownAt = now;
    // Persistent, because a broken settings file silently reverts the app to defaults: a four-second toast would let
    // the user miss that their changes are not in effect.
    pushToast('error', message, { persist: true, action: { id: 'settings.openSource' } });
}

/**
 * Keeps one persistent notice in step with the Server's configuration errors: shown while any exist, retracted once a
 * snapshot reports none (the file was fixed).
 */
export function syncConfigErrorNotice(
    errors: readonly string[] | undefined,
    now = Date.now(),
): void {
    const message = configErrorMessage(errors ?? []);
    if (message === undefined) {
        const previous = shown.message;
        if (previous === undefined) return;
        shown.message = undefined;
        dismissToastsMatching((title) => title === previous);
        return;
    }
    showConfigErrorMessage(message, now);
}

/**
 * A `*.changed` event that carried a load error: the error names its file, and the next snapshot reconciles the full
 * list.
 */
export function showConfigChangeError(error: string): void {
    showConfigErrorMessage(error);
}

export function resetConfigErrorNoticeForTest(): void {
    shown.message = undefined;
}
