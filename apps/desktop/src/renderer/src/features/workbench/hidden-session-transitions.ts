/**
 * Animations this module paused per Session wrapper, so showing the Session resumes exactly those.
 */
const pausedBySession = new WeakMap<Element, Set<Animation>>();

/**
 * Quiets the animations of retained Workbench Sessions once they are off screen, and resumes them on return.
 *
 * - CSS transitions (such as the Chat composer's `focus-within` border fade, started by the blur that hiding causes) are
 *   cancelled. The hidden subtree skips style updates (`content-visibility: hidden`), so Chromium never retires them
 *   once they finish, and each one keeps the compositor asking for a frame 120 times a second while the app is
 *   otherwise idle. Cancelling only drops the interpolation, so the property already sits at its final value.
 * - Running CSS animations (the buddy's bob and blink) are paused and later played again from where they stopped. This
 *   used to be a `.workbench-session[hidden] *` rule with `animation-play-state: paused`, but a descendant rule keyed
 *   on `[hidden]` forces Chromium to restyle the whole subtree when the Session shows again, which was most of the long
 *   frame on every Session switch. Animations created inside a hidden Session do not start while its style stays
 *   skipped; one that a layout or style read inside it happens to force starts anyway, and the next switch pauses it.
 *
 * Idempotent, and meant to run after the switch has painted so the `getAnimations` flush stays off the click path.
 */
export function reconcileSessionAnimations(root: ParentNode): void {
    for (const session of root.querySelectorAll('.workbench-session')) {
        if (session.hasAttribute('hidden')) {
            let paused = pausedBySession.get(session);
            const animations = session.getAnimations({ subtree: true });
            for (const animation of animations) {
                if (animation instanceof CSSTransition) {
                    animation.cancel();
                } else if (animation instanceof CSSAnimation && animation.playState === 'running') {
                    animation.pause();
                    if (!paused) {
                        paused = new Set();
                        pausedBySession.set(session, paused);
                    }
                    paused.add(animation);
                }
            }
        } else {
            const paused = pausedBySession.get(session);
            if (!paused) continue;
            pausedBySession.delete(session);
            for (const animation of paused) if (animation.playState === 'paused') animation.play();
        }
    }
}
