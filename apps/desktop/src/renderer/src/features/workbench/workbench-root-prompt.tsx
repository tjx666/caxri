import { useState } from 'react';

import { FolderGit2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../stores/selectors';
import { describeFailure, pushToast } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import {
    dismissWorkbenchRootCandidate,
    useWorkbenchRootPromptStore,
} from './workbench-root-prompt-store';

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

    const continueInWorktree = async (): Promise<void> => {
        if (pending) return;
        setPending(true);
        try {
            await caxri.request('session.continueInWorktree', candidate);
            dismissWorkbenchRootCandidate(sessionId);
            await refreshWorkbench();
        } catch (error) {
            dismissWorkbenchRootCandidate(sessionId);
            pushToast('error', describeFailure(error, 'Unable to continue in worktree'));
        } finally {
            setPending(false);
        }
    };

    const dismiss = async (): Promise<void> => {
        if (pending) return;
        setPending(true);
        try {
            await caxri.request('session.dismissWorkbenchCandidate', candidate);
        } catch (error) {
            pushToast('error', describeFailure(error, 'Unable to dismiss worktree suggestion'));
        } finally {
            /**
             * An expired candidate is already inert in Server and must not strand the prompt.
             */
            dismissWorkbenchRootCandidate(sessionId);
            setPending(false);
        }
    };

    return (
        <aside
            aria-label="New Git worktree"
            className="fixed bottom-10 left-1/2 z-[75] flex max-w-[560px] -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-elevated px-3 py-2 shadow-[0_8px_24px_var(--shadow)]"
            role="status"
        >
            <FolderGit2 aria-hidden="true" className="flex-none text-muted" size={16} />
            <span className="min-w-0 flex-1 text-[12px] text-foreground">
                A new Git worktree was created for this Session.
            </span>
            <Button
                disabled={pending}
                size="sm"
                variant="ghost"
                onClick={() => {
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, dismiss() reports its own errors
                    void dismiss();
                }}
            >
                Not Now
            </Button>
            <Button
                disabled={pending}
                size="sm"
                onClick={() => {
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, continueInWorktree() reports its own errors
                    void continueInWorktree();
                }}
            >
                Continue Session in Worktree
            </Button>
        </aside>
    );
}
