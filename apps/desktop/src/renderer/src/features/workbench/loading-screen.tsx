import { Code2 } from 'lucide-react';
import { useSonner } from 'sonner';

/**
 * Shown until the first `app.bootstrap` resolves; a failure replaces the wait with its reason.
 */
export function LoadingScreen() {
    const { toasts } = useSonner();
    const message = toasts[0]?.title;
    return (
        <main className="loading-screen flex h-screen w-screen flex-col items-center justify-center gap-3 bg-background text-muted">
            <Code2 size={25} />
            <span>{typeof message === 'string' ? message : 'Starting Caxri…'}</span>
        </main>
    );
}
