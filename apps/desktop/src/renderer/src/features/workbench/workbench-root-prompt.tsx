import { useState } from 'react';

import { FolderGit2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useSelectedSession } from '../../stores/selectors';
import {
    continueSessionInWorktree,
    dismissWorkbenchCandidate,
} from './workbench-root-prompt-commands';
import { useWorkbenchRootPromptStore } from './workbench-root-prompt-store';

/**
 * Non-modal prompt: Terminal and Editor interaction remain available while the user decides.
 */
export function WorkbenchRootPrompt() {
    const sessionId = useSelectedSession()?.id;
    const candidate = useWorkbenchRootPromptStore((state) =>
        sessionId ? state.candidates[sessionId] : undefined,
    );
    const [pending, setPending] = useState(false);
    if (!candidate || !sessionId) return null;

    const runOnce = async (command: () => Promise<void>): Promise<void> => {
        if (pending) return;
        setPending(true);
        try {
            await command();
        } finally {
            setPending(false);
        }
    };

    return (
        <aside
            aria-label="New Git worktree"
            className="fixed bottom-10 left-1/2 z-[75] grid w-[min(560px,calc(100vw-32px))] -translate-x-1/2 grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-md border border-border bg-elevated px-3 py-2 shadow-[0_8px_24px_var(--shadow)]"
            role="status"
        >
            <FolderGit2 aria-hidden="true" className="flex-none text-muted" size={16} />
            <span className="min-w-0 flex-1 text-[12px] text-foreground">
                A new Git worktree was created for this Session.
                <span className="mt-1 block text-[11px] break-all text-muted">
                    {candidate.rootPath}
                </span>
            </span>
            <div className="col-start-2 flex justify-end gap-2">
                <Button
                    disabled={pending}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, the command reports its own errors
                        void runOnce(() => dismissWorkbenchCandidate(sessionId, candidate));
                    }}
                >
                    Not Now
                </Button>
                <Button
                    disabled={pending}
                    size="sm"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, the command reports its own errors
                        void runOnce(() => continueSessionInWorktree(sessionId, candidate));
                    }}
                >
                    Continue Session in Worktree
                </Button>
            </div>
        </aside>
    );
}
