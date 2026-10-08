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
export type ExternalLinkChoice = 'open_once' | 'trust' | 'trust_parent' | 'cancel';

/**
 * A second trust button makes the generic label ambiguous ("Trust Domain" no longer says which domain), so the
 * exact-origin button names its host once there is something to confuse it with. With no parent candidate the wording,
 * the count, and the indices stay exactly as they were.
 */
function externalLinkButtons(target: URL, canTrust: boolean, parentHostname?: string): string[] {
    if (!canTrust) return ['Open Once', 'Cancel'];
    if (!parentHostname) return ['Open Once', 'Trust Domain and Open', 'Cancel'];
    return [
        'Open Once',
        `Trust ${target.host} and Open`,
        `Trust *.${parentHostname} and Open`,
        'Cancel',
    ];
}

/**
 * The full URL (not just the host) is what makes consent meaningful: a plausible host can still carry a hostile path or
 * query, and this dialog is the last point where the user can see it. When a wildcard rule is on offer the detail also
 * has to say how much wider it is, because nothing in `venice.ai` distinguishes a domain one party owns from a hosting
 * domain anyone can publish under.
 */
function externalLinkDetail(target: URL, canTrust: boolean, parentHostname?: string): string {
    if (!canTrust) return `${target.href}\n\nYou can open this link once.`;
    if (!parentHostname)
        return `${target.href}\n\nYou can open this link once or trust this exact origin for future links. Trusted origins can be reviewed or removed in Settings.`;
    return `${target.href}\n\nTrusting ${target.host} covers that host alone. Trusting *.${parentHostname} covers every subdomain of ${parentHostname}, including ones you have never visited — on a shared hosting domain that means sites other people control. Both rules can be reviewed or removed in Settings.`;
}

export function externalLinkPrompt(
    target: URL,
    canTrust: boolean,
    parentHostname?: string,
): MessageBoxOptions {
    const detail = externalLinkDetail(target, canTrust, parentHostname);
    const buttons = externalLinkButtons(target, canTrust, parentHostname);
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

export function externalLinkChoice(
    response: number,
    canTrust: boolean,
    hasParentOption = false,
): ExternalLinkChoice {
    if (response === 0) return 'open_once';
    if (!canTrust) return 'cancel';
    if (response === 1) return 'trust';
    /**
     * Index 2 is the wildcard button only when that button was rendered; in the three-button shape it is Cancel and
     * must never be read as a request to trust a whole domain.
     */
    return hasParentOption && response === 2 ? 'trust_parent' : 'cancel';
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
 * Precedes the macOS administrator prompt, which on its own only says that osascript wants to make changes; this is
 * where the user learns what will change and why a password is needed. Mirrors VS Code's shell command prompt.
 */
export function shellCommandElevationPrompt(
    action: 'install' | 'uninstall',
    linkPath: string,
): MessageBoxOptions {
    const isInstall = action === 'install';
    return {
        type: 'info',
        title: isInstall ? "Install 'caxri' Command" : "Uninstall 'caxri' Command",
        message: `Caxri will now prompt for administrator privileges to ${isInstall ? 'install' : 'uninstall'} the 'caxri' shell command.`,
        detail: isInstall
            ? `${linkPath} will link to the caxri launcher inside this Caxri app.`
            : `${linkPath} will be removed. The Caxri app itself is not affected.`,
        buttons: ['OK', 'Cancel'],
        defaultId: 0,
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
    folderClause: string,
): MessageBoxOptions {
    const plural = runningTerminals === 1 ? '' : 's';
    return {
        type: 'warning',
        title: `Delete ${kind}`,
        message:
            runningTerminals > 0
                ? `Delete '${title}' and terminate ${runningTerminals} running Terminal${plural}?`
                : `Delete '${title}'?`,
        detail: `Only Caxri metadata and snapshots are deleted. ${folderClause} and its files are never touched.`,
        buttons: [`Delete ${kind}`, 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    };
}

/**
 * How many worktree Project titles the detail names before it switches to a count. A dialog that lists thirty rows is
 * one nobody reads; a few names are enough to recognize what is going away.
 */
const NAMED_WORKTREE_PROJECT_LIMIT = 5;

/**
 * A worktree Project registered on another Project's behalf is hidden from the PrimarySidebar and has no delete command
 * of its own, so this cascade is the only way one is ever removed. That makes naming them part of the consent: the user
 * is deleting records they cannot see.
 *
 * The copy is careful about what does _not_ go with them. Such a Project never holds a Session of its own (the Server
 * refuses to create one there), so the Sessions in play are the ones adopting the worktree as their Workbench Root, and
 * those survive with their root reset. Saying "and their Sessions" would name a set that is always empty while implying
 * the one set that is never deleted.
 */
export function deleteProjectPrompt(
    title: string,
    runningTerminals: number,
    worktreeProjectTitles: readonly string[] = [],
): MessageBoxOptions {
    const prompt = deletePrompt('Project', title, runningTerminals, 'The Project folder');
    const count = worktreeProjectTitles.length;
    if (count === 0) return prompt;
    const named = worktreeProjectTitles.slice(0, NAMED_WORKTREE_PROJECT_LIMIT);
    const listed = named.map((worktreeTitle) => `'${worktreeTitle}'`).join(', ');
    const remainder = count - named.length;
    const names = remainder > 0 ? `${listed}, and ${remainder} more` : listed;
    const isSingle = count === 1;
    const cascade = isSingle
        ? `1 linked worktree Project is removed with it: ${names}.`
        : `${count} linked worktree Projects are removed with it: ${names}.`;
    const provenance = `Caxri registered ${isSingle ? 'it' : 'them'} automatically when a Session adopted the worktree, and a cascade like this is the only way ${isSingle ? 'it is' : 'they are'} removed. Any Session still working in ${isSingle ? 'it' : 'one of them'} survives, with its Workbench Root back at its own Project root.`;
    return { ...prompt, detail: `${cascade} ${provenance}\n\n${prompt.detail}` };
}

export function deleteSessionPrompt(title: string, runningTerminals: number): MessageBoxOptions {
    return deletePrompt('Session', title, runningTerminals, 'The selected folder');
}

/**
 * Bulk deletion from the Archived Sessions manager. A single prompt names the count instead of every title so the
 * dialog stays readable for large selections; one Session still routes through {@link deleteSessionPrompt}.
 */
export function deleteSessionsPrompt(
    sessionCount: number,
    runningTerminals: number,
): MessageBoxOptions {
    const terminalPlural = runningTerminals === 1 ? '' : 's';
    return {
        type: 'warning',
        title: 'Delete Sessions',
        message:
            runningTerminals > 0
                ? `Delete ${sessionCount} Sessions and terminate ${runningTerminals} running Terminal${terminalPlural}?`
                : `Delete ${sessionCount} Sessions?`,
        detail: 'Only Caxri metadata and snapshots are deleted. The selected folders and their files are never touched.',
        buttons: ['Delete Sessions', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    };
}

export function revokeMobileDevicePrompt(device: {
    displayName: string;
    platform: 'android' | 'ios';
}): MessageBoxOptions {
    const platform = device.platform === 'ios' ? 'iOS' : 'Android';
    return {
        type: 'warning',
        title: 'Revoke Mobile Device',
        message: `Revoke '${device.displayName}'?`,
        detail: `This ${platform} device immediately loses access to Caxri. To reconnect it, you must pair it again. Projects and files are not affected.`,
        buttons: ['Revoke Device', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    };
}

/**
 * Discarding working-tree changes is the one Git action that destroys work with no reflog or Trash to recover from, so
 * the detail always states what is lost and whether recovery exists.
 */
export function discardGitChangesPrompt(target: {
    repositoryName: string;
    scope: { kind: 'all'; fileCount: number } | { kind: 'file'; path: string; untracked: boolean };
}): MessageBoxOptions {
    if (target.scope.kind === 'file') {
        const untracked = target.scope.untracked;
        return {
            type: 'warning',
            title: 'Discard Changes',
            message: untracked
                ? `Delete '${target.scope.path}'?`
                : `Discard changes in '${target.scope.path}'?`,
            detail: untracked
                ? 'This file is untracked. It will be permanently deleted and cannot be restored.'
                : 'The file is restored to its last committed state. Uncommitted changes cannot be restored.',
            buttons: [untracked ? 'Delete File' : 'Discard Changes', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        };
    }
    const plural = target.scope.fileCount === 1 ? '' : 's';
    return {
        type: 'warning',
        title: 'Discard All Changes',
        message: `Discard all changes in ${target.scope.fileCount} file${plural} in '${target.repositoryName}'?`,
        detail: 'Tracked files are restored to their last committed state and untracked files are permanently deleted. Uncommitted changes cannot be restored.',
        buttons: ['Discard All Changes', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    };
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
         * MacOS convention: Enter saves, Escape cancels, never the destructive choice.
         */
        defaultId: 0,
        cancelId: 2,
    };
}

export function unsavedChangesChoice(response: number): DiscardChoice {
    if (response === 0) return 'save';
    return response === 1 ? 'discard' : 'cancel';
}
