import { useEffect, useRef, useState } from 'react';

import { FolderGit2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { awaitThenCleanup } from '../../lib/await-then-cleanup';
import { isEditableEventTarget } from '../../lib/keybindings';
import { restorePickerFocus } from '../../lib/picker-final-focus';
import { useDialogStore } from '../../stores/dialogs';
import { useSelectedSession } from '../../stores/selectors';
import {
    continueSessionInWorktree,
    dismissWorkbenchCandidate,
} from './workbench-root-prompt-commands';
import { resolveWorkbenchRootPromptKey } from './workbench-root-prompt-keyboard';
import { useWorkbenchRootPromptStore } from './workbench-root-prompt-store';

/**
 * Non-modal prompt: Terminal and Editor interaction remain available while the user decides.
 *
 * It never takes focus by itself. `Shift+Escape` brings focus here from anywhere (including the Terminal that swallows
 * Tab) and `Escape` answers "Not Now"; {@link resolveWorkbenchRootPromptKey} records why those two chords and no others.
 * Answering the prompt by either route returns focus where it came from, so a keyboard user is never left on
 * `document.body` with the next Tab restarting at the top of the document.
 */
export function WorkbenchRootPrompt() {
    const { t } = useTranslation();
    const sessionId = useSelectedSession()?.id;
    const candidate = useWorkbenchRootPromptStore((state) =>
        sessionId ? state.candidates[sessionId] : undefined,
    );
    const [pending, setPending] = useState(false);
    /**
     * The window listener is installed once per candidate, so it reads the in-flight state through a ref rather than
     * closing over a stale render.
     */
    const isPendingReference = useRef(false);
    const promptReference = useRef<HTMLElement>(null);
    const focusOriginReference = useRef<HTMLElement | null>(null);

    const runOnce = async (command: () => Promise<void>): Promise<void> => {
        if (isPendingReference.current) return;
        isPendingReference.current = true;
        setPending(true);
        // Read now, not in `finally`: answering the prompt unmounts it, and React nulls the ref on the way out.
        const promptElement = promptReference.current;
        const focusOrigin = focusOriginReference.current;
        await awaitThenCleanup(command(), () => {
            isPendingReference.current = false;
            setPending(false);
            // The answered prompt takes its focused button with it, so focus would otherwise land on `document.body`
            // and the next Tab would restart at the top of the document. Hand it back to the element `Shift+Escape`
            // took it from, or (for a pointer answer, which recorded no origin) to the workbench's registered
            // fallback, which is the active pane's Terminal.
            restorePickerFocus(focusOrigin, promptElement);
        });
    };

    useEffect(() => {
        if (!candidate || !sessionId) return;
        const onKeyDown = (event: KeyboardEvent): void => {
            const action = resolveWorkbenchRootPromptKey({
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                isEditableTarget: isEditableEventTarget(event.target),
                isModalOpen: useDialogStore.getState().isModalOpen(),
                key: event.key,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
            });
            if (action === 'ignore') return;
            // Capture phase plus both stops: xterm and Monaco would otherwise consume the chord before it arrives.
            event.preventDefault();
            event.stopPropagation();
            if (action === 'focus') {
                focusOriginReference.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                promptReference.current?.focus({ preventScroll: true });
                return;
            }
            // eslint-disable-next-line no-void -- intentional floating-promise discard, the command reports its own errors
            void runOnce(() => dismissWorkbenchCandidate(sessionId, candidate));
        };
        addEventListener('keydown', onKeyDown, { capture: true });
        return () => removeEventListener('keydown', onKeyDown, { capture: true });
        // `runOnce` is deliberately absent: it is re-created every render and guards itself through
        // `isPendingReference`, so listing it would swap the window listener on every keystroke.
    }, [candidate, sessionId]);

    if (!candidate || !sessionId) return null;

    return (
        <aside
            ref={promptReference}
            aria-keyshortcuts="Shift+Escape"
            aria-label={t('workbench.rootPrompt.label')}
            className="fixed bottom-10 left-1/2 z-[75] grid w-[min(560px,calc(100vw-32px))] -translate-x-1/2 grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-md border border-border bg-elevated px-3 py-2 shadow-[0_8px_24px_var(--shadow)] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
            role="status"
            tabIndex={-1}
        >
            <FolderGit2 aria-hidden="true" className="flex-none text-muted" size={16} />
            <span className="min-w-0 flex-1 text-[12px] text-foreground">
                {t('workbench.rootPrompt.message')}
                {/*
                 * `aria-keyshortcuts` is only read once focus is already here, and a live region announces its
                 * content rather than its label, so the route in has to be part of what is announced.
                 */}
                <span className="sr-only"> {t('workbench.rootPrompt.focusHint')}</span>
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
                    {t('workbench.rootPrompt.notNow')}
                </Button>
                <Button
                    disabled={pending}
                    size="sm"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, the command reports its own errors
                        void runOnce(() => continueSessionInWorktree(sessionId, candidate));
                    }}
                >
                    {t('workbench.rootPrompt.continue')}
                </Button>
            </div>
        </aside>
    );
}
