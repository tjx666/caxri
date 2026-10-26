import { useSonner } from 'sonner';

/**
 * Shown until the first `app.bootstrap` resolves. It paints nothing of its own while startup is healthy: the inline
 * `#startup-loader` from `index.html` keeps showing the Caxri mark over the translucent window, so the handoff from the
 * pre-bundle frame to React is invisible. A failure adds its reason under the mark.
 */
export function LoadingScreen() {
    const { toasts } = useSonner();
    const message = toasts[0]?.title;
    return (
        <main className="loading-screen flex h-screen w-screen items-center justify-center [-webkit-app-region:drag]">
            {typeof message === 'string' && (
                /*
                The window is a drag region; the message opts out so its text can be selected and copied.
                */
                <span
                    role="status"
                    className="mt-28 max-w-md px-6 text-center text-muted select-text [-webkit-app-region:no-drag]"
                >
                    {message}
                </span>
            )}
        </main>
    );
}
