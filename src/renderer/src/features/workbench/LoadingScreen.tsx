import { Code2 } from 'lucide-react';

import { useToastStore } from '../../state/toasts';

/** Shown until the first `app.bootstrap` resolves; a failure replaces the wait with its reason. */
export function LoadingScreen() {
    const message = useToastStore((state) => state.toast?.message);
    return (
        <main className="loading-screen">
            <Code2 size={25} />
            <span>{message ?? 'Attaching to Caxri Runtime…'}</span>
        </main>
    );
}
