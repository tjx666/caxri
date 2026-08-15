import type { MessageBoxOptions } from 'electron';

/**
 * Native confirmation copy and button semantics, kept separate from the IPC handlers that show them. DESIGN.md requires
 * every destructive command to name its target and state what is and is not affected; expressing that as pure functions
 * makes the wording, the default button, and the Escape target directly testable instead of reachable only through a
 * live `dialog` call.
 *
 * Every prompt here follows the macOS convention that Escape maps to the non-destructive choice.
 */

/**
 * Buttons are indexed, so the mapping back to a decision belongs next to the copy that defines it.
 */
export type ExternalLinkChoice = 'open_once' | 'trust' | 'cancel';

export function externalLinkPrompt(target: URL, canTrust: boolean): MessageBoxOptions {
    /**
     * The full URL — not just the host — is what makes consent meaningful: a plausible host can still carry a hostile
     * path or query, and this dialog is the last point where the user can see it.
     */
    const detail = canTrust
        ? `${target.href}\n\nYou can open this link once or trust this exact origin for future links. Trusted origins can be reviewed or removed in Settings.`
        : `${target.href}\n\nYou can open this link once.`;
    const buttons = canTrust
        ? ['Open Once', 'Trust Domain and Open', 'Cancel']
        : ['Open Once', 'Cancel'];
    return {
        type: 'question',
        title: 'Open External Link',
        message: `Open ${target.host} in your default browser?`,
        detail,
        buttons,
        defaultId: buttons.length - 1,
        cancelId: buttons.length - 1,
    };
}

export function externalLinkChoice(response: number, canTrust: boolean): ExternalLinkChoice {
    if (response === 0) return 'open_once';
    return canTrust && response === 1 ? 'trust' : 'cancel';
}

export function trashPrompt(item: {
    name: string;
    path: string;
    hasUnsavedChanges?: boolean;
}): MessageBoxOptions {
    return {
        type: 'warning',
        title: 'Move to Trash',
        message: `Move '${item.name}' to the Trash?`,
        /**
         * The Trash only restores what was last written to disk, so the blanket "you can recover this" reassurance
         * would be false for a file whose Editor tab still holds unsaved changes.
         */
        detail: item.hasUnsavedChanges
            ? `${item.path}\n\nThis file has unsaved changes in the editor. Only the last saved version can be recovered from the Trash.`
            : `${item.path}\n\nYou can recover this item from the Trash.`,
        buttons: ['Move to Trash', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    };
}

/**
 * Deleting a Project or a Session removes Caxri metadata only. The detail line says so explicitly because the verb is
 * the same one file managers use for erasing files.
 */
function deletePrompt(
    kind: 'Project' | 'Session',
    title: string,
    runningTerminals: number,
    directoryClause: string,
): MessageBoxOptions {
    const plural = runningTerminals === 1 ? '' : 's';
    return {
        type: 'warning',
        title: `Delete ${kind}`,
        message:
            runningTerminals > 0
                ? `Delete '${title}' and terminate ${runningTerminals} running Terminal${plural}?`
                : `Delete '${title}'?`,
        detail: `Only Caxri metadata and snapshots are deleted. ${directoryClause} and its files are never touched.`,
        buttons: [`Delete ${kind}`, 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    };
}

export function deleteProjectPrompt(title: string, runningTerminals: number): MessageBoxOptions {
    return deletePrompt('Project', title, runningTerminals, 'The Project directory');
}

export function deleteSessionPrompt(title: string, runningTerminals: number): MessageBoxOptions {
    return deletePrompt('Session', title, runningTerminals, 'The selected directory');
}

export type DiscardChoice = 'save' | 'discard' | 'cancel';

export function unsavedChangesPrompt(name: string): MessageBoxOptions {
    return {
        type: 'warning',
        title: 'Unsaved Changes',
        message: `Do you want to save the changes you made to '${name}'?`,
        detail: "Your changes will be lost if you don't save them.",
        buttons: ['Save', "Don't Save", 'Cancel'],
        /**
         * MacOS convention: Enter saves, Escape cancels — never the destructive choice.
         */
        defaultId: 0,
        cancelId: 2,
    };
}

export function unsavedChangesChoice(response: number): DiscardChoice {
    if (response === 0) return 'save';
    return response === 1 ? 'discard' : 'cancel';
}
