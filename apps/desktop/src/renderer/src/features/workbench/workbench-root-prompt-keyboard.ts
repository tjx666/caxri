/**
 * What a keystroke means to the worktree adoption prompt while it is on screen.
 *
 * - `focus`: move keyboard focus into the prompt.
 * - `dismiss`: answer "Not Now".
 * - `ignore`: the keystroke belongs to whatever owns focus.
 */
export type WorkbenchRootPromptKeyAction = 'focus' | 'dismiss' | 'ignore';

/**
 * The prompt is an offer Caxri makes about something the Agent did, not a question the user asked, so DESIGN.md's modal
 * rule applies in the negative: "a modal belongs to a user who asked", and taking the screen or the Escape key for news
 * that can wait is exactly the nag that rule exists to prevent. It therefore never seizes focus on appearance: with
 * focus usually inside a Terminal, a stolen keystroke would land on a button, and a stray `Enter` would activate
 * `Continue Session in Worktree` without anyone reading it.
 *
 * That leaves the reachability half. DESIGN.md's chrome rules require every interactive element to be
 * keyboard-reachable, and they name the escape hatch for a surface that a focused Terminal hides: "Global shortcuts
 * never fire while focus is in an editable target … unless the binding explicitly opts in." So the prompt opts in with
 * exactly one chord:
 *
 * - `Shift+Escape` moves focus into the prompt from anywhere, including a Terminal, Monaco, or a text field. Plain
 *   `Escape` cannot do this job: it is a real control character a shell, `vi`, or Monaco owns, and stealing it would
 *   break the surface the user is actually working in.
 * - `Escape` dismisses the prompt wherever an editable target is not holding it: the file tree, the status bar, the
 *   prompt itself once `Shift+Escape` has brought focus there, or a window with nothing focused at all.
 *
 * A chord carrying any other modifier belongs to somebody else and is left alone, and both chords stand down entirely
 * while a modal is open. The listener runs in capture phase on `window`, so nothing can outrank it, which means an
 * unguarded `Escape` would close this background notice instead of the dialog the user is looking at, and the one
 * keystroke would produce neither result the user expected. `session-activity-card-dismissal.ts` yields to modals the
 * same way for the same reason.
 */
export function resolveWorkbenchRootPromptKey({
    altKey,
    ctrlKey,
    isEditableTarget,
    isModalOpen,
    key,
    metaKey,
    shiftKey,
}: {
    altKey: boolean;
    ctrlKey: boolean;
    /**
     * True when a form control, a `contenteditable` region, Monaco, or an xterm pane owns the keystroke.
     */
    isEditableTarget: boolean;
    /**
     * True while a dialog, picker, or confirmation owns the screen. Escape belongs to it, and so does focus.
     */
    isModalOpen: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
}): WorkbenchRootPromptKeyAction {
    if (key !== 'Escape' || altKey || ctrlKey || metaKey) return 'ignore';
    if (isModalOpen) return 'ignore';
    if (shiftKey) return 'focus';
    return isEditableTarget ? 'ignore' : 'dismiss';
}
