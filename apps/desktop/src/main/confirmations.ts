import type { CommanderClearData, MethodResult } from '@caxri/protocol';
import type { MessageBoxOptions } from 'electron';

import { translateMain as t } from './locale';

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
    const openOnce = t('desktop.externalLink.openOnce');
    const cancel = t('desktop.dialog.cancel');
    if (!canTrust) return [openOnce, cancel];
    if (!parentHostname) return [openOnce, t('desktop.externalLink.trustDomain'), cancel];
    return [
        openOnce,
        t('desktop.externalLink.trustHost', { host: target.host }),
        t('desktop.externalLink.trustParent', { parent: parentHostname }),
        cancel,
    ];
}

/**
 * The full URL (not just the host) is what makes consent meaningful: a plausible host can still carry a hostile path or
 * query, and this dialog is the last point where the user can see it. When a wildcard rule is on offer the detail also
 * has to say how much wider it is, because nothing in `venice.ai` distinguishes a domain one party owns from a hosting
 * domain anyone can publish under.
 */
function externalLinkDetail(target: URL, canTrust: boolean, parentHostname?: string): string {
    if (!canTrust) return t('desktop.externalLink.detailOnce', { url: target.href });
    if (!parentHostname) return t('desktop.externalLink.detailTrust', { url: target.href });
    return t('desktop.externalLink.detailTrustParent', {
        url: target.href,
        host: target.host,
        parent: parentHostname,
    });
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
        title: t('desktop.externalLink.title'),
        message: t('desktop.externalLink.message', { host: target.host }),
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
    /**
     * The SSH Host whose Trash receives the item; absent for this Mac's Trash.
     */
    host?: string;
}): MessageBoxOptions {
    return {
        type: 'warning',
        title: t('desktop.trash.title'),
        message: t('desktop.trash.message', { name: item.name }),
        /**
         * The Trash only restores what was last written to disk, so the blanket "you can recover this" reassurance
         * would be false for a file whose Editor tab still holds unsaved changes.
         */
        detail: item.host
            ? t(
                  item.hasUnsavedChanges
                      ? 'desktop.trash.detailRemoteUnsaved'
                      : 'desktop.trash.detailRemote',
                  { host: item.host, path: item.path },
              )
            : t(item.hasUnsavedChanges ? 'desktop.trash.detailUnsaved' : 'desktop.trash.detail', {
                  path: item.path,
              }),
        buttons: [t('desktop.trash.confirm'), t('desktop.dialog.cancel')],
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
        title: t(
            isInstall ? 'desktop.shellCommand.installTitle' : 'desktop.shellCommand.uninstallTitle',
        ),
        message: t(
            isInstall
                ? 'desktop.shellCommand.installMessage'
                : 'desktop.shellCommand.uninstallMessage',
        ),
        detail: t(
            isInstall
                ? 'desktop.shellCommand.installDetail'
                : 'desktop.shellCommand.uninstallDetail',
            { path: linkPath },
        ),
        buttons: [t('desktop.dialog.ok'), t('desktop.dialog.cancel')],
        defaultId: 0,
        cancelId: 1,
    };
}

/**
 * Live work by kind, as `terminal.runningCount` reports it: PTY Terminals (a shell or an Agent CLI) and Chats.
 */
export type RunningWork = MethodResult<'terminal.runningCount'>;

const NO_RUNNING_WORK: RunningWork = { terminals: 0, chats: 0 };

export function runningWorkTotal({ terminals, chats }: RunningWork): number {
    return terminals + chats;
}

/**
 * Adds up per-Session counts for a prompt that covers several Sessions (a Project or a bulk delete).
 */
export function sumRunningWork(counts: readonly RunningWork[]): RunningWork {
    return counts.reduce(
        (sum, count) => ({
            terminals: sum.terminals + count.terminals,
            chats: sum.chats + count.chats,
        }),
        NO_RUNNING_WORK,
    );
}

/**
 * Names running work by kind, for example `2 Terminals and 1 Chat`, so a confirmation tells a plain shell from an Agent
 * still working. Each noun takes its own plural and a kind with nothing running is left out; `qualifier` precedes each
 * noun (`1 running Terminal`); each phrase is translated, so a locale can order the count and the noun its own way.
 * Every prompt that stops or keeps running work words it through here, so the window-close and deletion confirmations
 * stay consistent. Callers check {@link runningWorkTotal} first: nothing running reads as an empty string.
 */
export function runningWorkPhrase(
    { terminals, chats }: RunningWork,
    qualifier?: 'running',
): string {
    const terminalKey = qualifier
        ? 'desktop.runningWork.runningTerminal'
        : 'desktop.runningWork.terminal';
    const chatKey = qualifier ? 'desktop.runningWork.runningChat' : 'desktop.runningWork.chat';
    const parts = [
        [terminals, terminalKey],
        [chats, chatKey],
    ] as const;
    const phrases = parts
        .filter(([count]) => count > 0)
        .map(([count, key]) => t(`${key}${count === 1 ? 'One' : 'Other'}`, { count }));
    if (phrases.length === 0) return '';
    return phrases.reduce((first, second) => t('desktop.runningWork.and', { first, second }));
}

/**
 * Deleting a Project or a Session removes Caxri metadata only. The detail line says so explicitly because the verb is
 * the same one file managers use for erasing files.
 */
function deletePrompt(
    kind: 'deleteProject' | 'deleteSession',
    title: string,
    running: RunningWork,
): MessageBoxOptions {
    return {
        type: 'warning',
        title: t(`desktop.${kind}.title`),
        message:
            runningWorkTotal(running) > 0
                ? t('desktop.delete.messageRunning', {
                      title,
                      running: runningWorkPhrase(running, 'running'),
                  })
                : t('desktop.delete.message', { title }),
        detail: t(`desktop.${kind}.detail`),
        buttons: [t(`desktop.${kind}.confirm`), t('desktop.dialog.cancel')],
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
    running: RunningWork,
    worktreeProjectTitles: readonly string[] = [],
): MessageBoxOptions {
    const prompt = deletePrompt('deleteProject', title, running);
    const count = worktreeProjectTitles.length;
    if (count === 0) return prompt;
    const named = worktreeProjectTitles.slice(0, NAMED_WORKTREE_PROJECT_LIMIT);
    const listed = named.map((worktreeTitle) => `'${worktreeTitle}'`).join(', ');
    const remainder = count - named.length;
    const names =
        remainder > 0
            ? t('desktop.deleteProject.worktreeMore', { names: listed, count: remainder })
            : listed;
    const isSingle = count === 1;
    const cascade = isSingle
        ? t('desktop.deleteProject.worktreeOne', { names })
        : t('desktop.deleteProject.worktreeOther', { names, count });
    const provenance = t(
        isSingle ? 'desktop.deleteProject.provenanceOne' : 'desktop.deleteProject.provenanceOther',
    );
    return { ...prompt, detail: `${cascade} ${provenance}\n\n${prompt.detail}` };
}

export function deleteSessionPrompt(title: string, running: RunningWork): MessageBoxOptions {
    return deletePrompt('deleteSession', title, running);
}

/**
 * Bulk deletion from the Archived Sessions manager. A single prompt names the count instead of every title so the
 * dialog stays readable for large selections; one Session still routes through {@link deleteSessionPrompt}.
 */
export function deleteSessionsPrompt(
    sessionCount: number,
    running: RunningWork,
): MessageBoxOptions {
    return {
        type: 'warning',
        title: t('desktop.deleteSessions.title'),
        message:
            runningWorkTotal(running) > 0
                ? t('desktop.deleteSessions.messageRunning', {
                      count: sessionCount,
                      running: runningWorkPhrase(running, 'running'),
                  })
                : t('desktop.deleteSessions.message', { count: sessionCount }),
        detail: t('desktop.deleteSessions.detail'),
        buttons: [t('desktop.deleteSessions.confirm'), t('desktop.dialog.cancel')],
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
        title: t('desktop.revokeDevice.title'),
        message: t('desktop.revokeDevice.message', { name: device.displayName }),
        detail: t('desktop.revokeDevice.detail', { platform }),
        buttons: [t('desktop.revokeDevice.confirm'), t('desktop.dialog.cancel')],
        defaultId: 1,
        cancelId: 1,
    };
}

/**
 * Clear Agent Commander Data names every kind of data the request removes, in the dialog's order, and states what
 * stays. Projects, Sessions, and the delegations those Sessions hold are never part of it.
 */
export function clearCommanderDataPrompt(request: CommanderClearData): MessageBoxOptions {
    const items = [
        request.tasks === 'all' && t('desktop.clearCommanderData.allTasks'),
        request.tasks === 'closed' && t('desktop.clearCommanderData.closedTasks'),
        Array.isArray(request.tasks) &&
            (request.tasks.length === 1
                ? t('desktop.clearCommanderData.someTasksOne')
                : t('desktop.clearCommanderData.someTasks', { count: request.tasks.length })),
        request.taskFiles && t('desktop.clearCommanderData.taskFiles'),
        request.inbox && t('desktop.clearCommanderData.inbox'),
        request.memory && t('desktop.clearCommanderData.memory'),
        request.instructions && t('desktop.clearCommanderData.instructions'),
        request.conversation && t('desktop.clearCommanderData.conversation'),
    ].filter((item): item is string => typeof item === 'string');
    return {
        type: 'warning',
        title: t('desktop.clearCommanderData.title'),
        message: t('desktop.clearCommanderData.message'),
        detail: [
            ...items.map((item) => `• ${item}`),
            '',
            t('desktop.clearCommanderData.detail'),
        ].join('\n'),
        buttons: [t('desktop.clearCommanderData.confirm'), t('desktop.dialog.cancel')],
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
            title: t('desktop.discard.title'),
            message: t(untracked ? 'desktop.discard.deleteMessage' : 'desktop.discard.message', {
                path: target.scope.path,
            }),
            detail: t(
                untracked ? 'desktop.discard.untrackedDetail' : 'desktop.discard.trackedDetail',
            ),
            buttons: [
                t(untracked ? 'desktop.discard.deleteFile' : 'desktop.discard.confirm'),
                t('desktop.dialog.cancel'),
            ],
            defaultId: 1,
            cancelId: 1,
        };
    }
    const { fileCount } = target.scope;
    return {
        type: 'warning',
        title: t('desktop.discardAll.title'),
        message: t(
            fileCount === 1 ? 'desktop.discardAll.messageOne' : 'desktop.discardAll.messageOther',
            { count: fileCount, repository: target.repositoryName },
        ),
        detail: t('desktop.discardAll.detail'),
        buttons: [t('desktop.discardAll.confirm'), t('desktop.dialog.cancel')],
        defaultId: 1,
        cancelId: 1,
    };
}

export type DiscardChoice = 'save' | 'discard' | 'cancel';

export function unsavedChangesPrompt(name: string): MessageBoxOptions {
    return {
        type: 'warning',
        title: t('desktop.unsaved.title'),
        message: t('desktop.unsaved.message', { name }),
        detail: t('desktop.unsaved.detail'),
        buttons: [
            t('desktop.unsaved.save'),
            t('desktop.unsaved.dontSave'),
            t('desktop.dialog.cancel'),
        ],
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

/**
 * "Edit from here" with file restore: the provider puts back the files the removed turns changed, which overwrites the
 * current contents, the user's own edits since included. Cancel is the default so Enter never reverts files.
 */
export function revertAgentChatFilesPrompt({
    providerName,
    removedTurns,
}: {
    providerName: string;
    removedTurns: number;
}): MessageBoxOptions {
    return {
        type: 'warning',
        title: t('desktop.revertFiles.title'),
        message: t(
            removedTurns === 1
                ? 'desktop.revertFiles.messageOne'
                : 'desktop.revertFiles.messageOther',
            { provider: providerName, count: removedTurns },
        ),
        detail: t('desktop.revertFiles.detail'),
        buttons: [t('desktop.revertFiles.confirm'), t('desktop.dialog.cancel')],
        defaultId: 1,
        cancelId: 1,
    };
}
