import type { Translate } from '../i18n';
import { translate } from '../i18n';
import { createStore } from '../lib/store';

/**
 * One modal question. The copy contract mirrors VS Code's modal message: the title asks the question, the message names
 * the consequence of confirming, and the buttons name the outcomes rather than restating "Yes"/"No".
 *
 * Destructive commands (Delete Session, Delete Project) still use the native confirm dialog Main owns (see DESIGN.md
 * "Confirmations"), so this request deliberately has no danger styling to reach for.
 */
export interface ConfirmRequest {
    /**
     * Dismissal label; defaults to the shared "Cancel".
     */
    cancelLabel?: string;
    /**
     * Confirming action label, phrased as the action itself ("Turn On"); defaults to the shared "OK".
     */
    confirmLabel?: string;
    /**
     * Label of an opt-out checkbox shown beside the buttons ("Don't ask again"). Only a confirmation reports it as
     * checked (see `ConfirmAnswer`), so the caller persists "do this without asking" and never "refuse without asking".
     * Callers read it through `showConfirmChoice`.
     */
    dontAskAgainLabel?: string;
    /**
     * One or two sentences stating what confirming changes and how reversible it is.
     */
    message: string;
    /**
     * The question, ending in a question mark.
     */
    title: string;
}

/**
 * The user's answer to a request that offered `dontAskAgainLabel`.
 */
export interface ConfirmAnswer {
    /**
     * True only when the user confirmed with the checkbox ticked; a dismissal never asks to stop asking.
     */
    dontAskAgain: boolean;
    isConfirmed: boolean;
}

interface ConfirmationState {
    isDontAskAgainChecked?: boolean;
    request?: ConfirmRequest;
    resolve?: (answer: ConfirmAnswer) => void;
}

const DISMISSED: ConfirmAnswer = { dontAskAgain: false, isConfirmed: false };

/**
 * Backs the single `ConfirmationDialog` mounted by `App`, the same one-instance-per-app pattern `ToastOutlet` uses for
 * notifications, so no feature has to mount (or style) its own confirmation surface.
 */
export const useConfirmationStore = createStore<ConfirmationState>('confirmations', () => ({}));

/**
 * Opens the shared confirmation modal and resolves with the user's answer: `true` for the confirming action, `false`
 * for Cancel, Escape, the close button, or an outside click. Reached from features as `caxri.window.showConfirm` (see
 * `lib/caxri.ts`).
 *
 * Only one question can be on screen at a time; a request arriving while another is still open answers the stale one
 * with `false` first, so no caller is left awaiting a promise that can never settle.
 */
// eslint-disable-next-line unicorn/consistent-boolean-name -- an action named like VS Code's `window.show*` API, not a predicate
export async function showConfirm(request: ConfirmRequest): Promise<boolean> {
    const answer = await showConfirmChoice(request);
    return answer.isConfirmed;
}

/**
 * `showConfirm` for a request that offers `dontAskAgainLabel`: resolves with the checkbox state as well.
 */
export function showConfirmChoice(request: ConfirmRequest): Promise<ConfirmAnswer> {
    return new Promise((resolve) => {
        useConfirmationStore.getState().resolve?.(DISMISSED);
        useConfirmationStore.setState({ isDontAskAgainChecked: false, request, resolve });
    });
}

/**
 * Ticks or clears the pending request's "Don't ask again" checkbox.
 */
export function setDontAskAgain(isChecked: boolean): void {
    useConfirmationStore.setState({ isDontAskAgainChecked: isChecked });
}

/**
 * Answers the pending question and closes the dialog; a no-op once already answered.
 */
export function resolveConfirm(isConfirmed: boolean): void {
    const { isDontAskAgainChecked, request, resolve } = useConfirmationStore.getState();
    if (!resolve) return;
    useConfirmationStore.setState({
        isDontAskAgainChecked: false,
        request: undefined,
        resolve: undefined,
    });
    resolve({
        dontAskAgain:
            isConfirmed &&
            request?.dontAskAgainLabel !== undefined &&
            isDontAskAgainChecked === true,
        isConfirmed,
    });
}

/**
 * Resolves the button labels a request left unset, so the dialog component stays render-only and the defaults are
 * covered by a unit test instead of living inside JSX.
 */
export function confirmationLabels(
    request: ConfirmRequest,
    t: Translate = translate,
): { cancel: string; confirm: string } {
    return {
        cancel: request.cancelLabel ?? t('common.cancel'),
        confirm: request.confirmLabel ?? t('common.ok'),
    };
}
