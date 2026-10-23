/**
 * Cancels the CSS transitions left in Workbench Sessions that just went off screen.
 *
 * Hiding a Session blurs it (`inert`), which starts transitions such as the Chat composer's `focus-within` border fade.
 * The hidden subtree then skips style updates (`content-visibility: hidden`), so Chromium never retires those
 * transitions once they finish, and each one keeps the compositor asking for a frame 120 times a second while the app
 * is otherwise idle. Cancelling a transition only drops its interpolation, so the property already sits at its final
 * value. CSS animations are left alone: a cancelled one stays cancelled, and the buddy would no longer move on return;
 * `styles.css` pauses those instead.
 */
export function cancelHiddenSessionTransitions(root: ParentNode): void {
    for (const session of root.querySelectorAll('.workbench-session[hidden]')) {
        const animations = session.getAnimations({ subtree: true });
        for (const animation of animations)
            if (animation instanceof CSSTransition) animation.cancel();
    }
}
