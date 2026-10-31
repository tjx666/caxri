import type { CaxriApi, GlobPatternSettings, WorkspaceChangeContext } from './api.js';
import type { Event } from './events.js';
import { Disposable } from './events.js';
import type { L10n } from './l10n.js';
import { createL10n } from './l10n.js';

/**
 * Matches a root-relative path using the Extension Host's shared glob semantics.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- The published stub preserves the signature replaced by the Extension Host.
export function isGlobMatch(_relativePath: string, _patterns: GlobPatternSettings): boolean {
    return unavailable('isGlobMatch');
}

function unavailable(method: string): never {
    const error = Object.assign(
        new Error(
            `The caxri API method ${method} is available only inside the Caxri Extension Host.`,
        ),
        { code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' },
    );
    Object.defineProperty(error, 'name', {
        configurable: true,
        enumerable: true,
        value: 'CaxriApiUnavailableError',
        writable: true,
    });
    throw error;
}

const outsideHostEvent =
    <T>(): Event<T> =>
    () =>
        new Disposable();

/**
 * Outside the Extension Host there is no app language, so messages stay in their English source form. Unlike the
 * workspace members this works instead of throwing: pure label helpers call it, and their unit tests run without a
 * Host.
 */
export const l10n: L10n = createL10n(() => {});

const caxri: CaxriApi = Object.freeze({
    env: Object.freeze({
        language: 'en',
        onDidChangeLanguage: outsideHostEvent<string>(),
    }),
    l10n,
    commands: Object.freeze({
        registerCommand: () => unavailable('commands.registerCommand'),
    }),
    views: Object.freeze({
        registerViewBadgeProvider: () => unavailable('views.registerViewBadgeProvider'),
        registerSourceControlProvider: () => unavailable('views.registerSourceControlProvider'),
        registerTreeDataProvider: () => unavailable('views.registerTreeDataProvider'),
    }),
    workspace: Object.freeze({
        onDidChangeActiveContext: outsideHostEvent<WorkspaceChangeContext>(),
        onDidChangeGit: outsideHostEvent<WorkspaceChangeContext>(),
        onDidChangeProjectStatus: outsideHostEvent<WorkspaceChangeContext>(),
        git: Object.freeze({
            commits: () => unavailable('workspace.git.commits'),
            commitDetails: () => unavailable('workspace.git.commitDetails'),
            discard: () => unavailable('workspace.git.discard'),
            mergePullRequest: () => unavailable('workspace.git.mergePullRequest'),
            pullRequestChanges: () => unavailable('workspace.git.pullRequestChanges'),
            remoteHost: () => unavailable('workspace.git.remoteHost'),
            summary: () => unavailable('workspace.git.summary'),
            sync: () => unavailable('workspace.git.sync'),
        }),
        getCurrentContext: () => unavailable('workspace.getCurrentContext'),
        getConfiguration: () => unavailable('workspace.getConfiguration'),
        getProjectStatus: () => unavailable('workspace.getProjectStatus'),
    }),
    /**
     * Unlike every other member here this does not call {@link unavailable}: it mints a value rather than reaching into
     * the Host, so a provider under unit test can still throw it and assert the code. The object simply is not
     * registered as a declared non-fault: outside the Extension Host there is no classifier to declare it to, and an
     * unregistered error is classified exactly as it was before this contract existed.
     */
    supersededError: (message: string) =>
        Object.assign(new Error(message), { code: 'GENERATION_EXPIRED' }),
});

export default caxri;
