/**
 * Publishes whether this window is the focused one as `data-window-active` on the document element, so the title-bar
 * roles can pick their active or inactive color in CSS alone.
 *
 * The signal has to reach the stylesheet because `titleBarInactiveBackground` and `titleBarInactiveForeground` are
 * theme values, not component state: every surface that paints a title bar must switch together. CSS cannot read the
 * condition on its own: `:window-inactive` is a WebKit pseudo-class and Chromium, which is what Electron runs, has no
 * equivalent. The attribute lands on `document.documentElement`, the same element `applyCssTheme` writes the color
 * variables to, so one element carries the whole painting context.
 *
 * Each Renderer entry point calls this for its own window (the Workbench and the Process Explorer are separate windows
 * and focus one at a time) before mounting React, not from an effect. The title bar's base classes are its active
 * colors and `window-inactive:` only overrides them, so a window that paints its first frame unfocused would show
 * active chrome until an effect ran. Publishing ahead of the first render closes that gap.
 *
 * A window observes for its whole lifetime, so only tests tear the listeners down again, and the attribute is left as
 * it was: a window being torn down has nothing left to paint.
 *
 * @returns A teardown that stops publishing focus changes.
 */
export function observeWindowActive(): () => void {
    const publish = (): void => {
        document.documentElement.dataset.windowActive = String(document.hasFocus());
    };
    publish();
    addEventListener('focus', publish);
    addEventListener('blur', publish);
    return () => {
        removeEventListener('focus', publish);
        removeEventListener('blur', publish);
    };
}
