/**
 * The fields of a React or DOM `keydown` that reveal an active IME composition. A React event carries the flag on
 * `nativeEvent`; a DOM event carries it directly.
 */
export interface ImeKeyboardEventLike {
    readonly isComposing?: boolean;
    readonly keyCode: number;
    readonly nativeEvent?: { readonly isComposing: boolean };
}

/**
 * True while an input method (Chinese, Japanese, Korean) is composing. Enter and Escape then belong to the candidate
 * window: Enter accepts the highlighted candidate and Escape abandons the composition, yet the browser still dispatches
 * them to the input. A text-input handler that acts on Enter or Escape must return early on this, or it commits,
 * submits, or closes on the keystroke the user meant to finish typing with.
 *
 * `isComposing` is the spec's signal; `keyCode === 229` covers the composition-ending keystroke on engines (Safari,
 * WebKit-based IMEs) that report it only that way. https://www.w3.org/TR/uievents/#events-composition-key-events
 */
export function isImeComposing(event: ImeKeyboardEventLike): boolean {
    if (event.nativeEvent?.isComposing || event.isComposing) return true;
    // oxlint-disable-next-line typescript/no-deprecated -- 229 is the only signal for this keystroke; see the JSDoc above
    return event.keyCode === 229;
}
