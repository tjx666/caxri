/**
 * Replays the Session attention ripples when this window gains focus.
 *
 * The ripple around a Session that needs the user plays three times and then stops (an infinite ripple kept the
 * compositor and Renderer busy for as long as the Session waited, about 2.4% Renderer CPU for five rows). A Session can
 * enter that state while the user is in another app, so its three ripples may have played unseen; returning to the
 * window plays every visible ripple again. `Animation.play()` rewinds a finished animation to its start.
 *
 * The Workbench entry installs this before mounting React; only tests tear it down.
 *
 * @returns A teardown that stops replaying on focus.
 */
export function replayAttentionRipplesOnFocus(): () => void {
    const replay = (): void => {
        for (const ripple of document.querySelectorAll('[data-session-status-ripple]')) {
            for (const animation of ripple.getAnimations()) animation.play();
        }
    };
    addEventListener('focus', replay);
    return () => removeEventListener('focus', replay);
}
