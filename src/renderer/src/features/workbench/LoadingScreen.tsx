import { Code2 } from 'lucide-react';

import { useToastStore } from '../../state/toasts';

/** Shown until the first `app.bootstrap` resolves; a failure replaces the wait with its reason. */
export function LoadingScreen() {
    const message = useToastStore((state) => state.toasts.at(-1)?.message);
    return (
        <main className="loading-screen flex h-screen w-screen flex-col items-center justify-center gap-3 bg-background text-muted">
            <Code2 size={25} />
            <span>{message ?? 'Starting Caxri…'}</span>
        </main>
    );
}
