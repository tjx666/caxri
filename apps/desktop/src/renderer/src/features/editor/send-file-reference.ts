import type { MethodResult, SessionRecord } from '@caxri/protocol';
import { isVirtualEditorTabPath, parseGitDiffTab } from '@caxri/protocol';

import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';
import { caxriQueryKey, queryClient } from '../../queries/client';
import {
    getBootstrap,
    getSelectedSession,
    getSessionState,
    selectSelectedWorkbenchProject,
} from '../../stores/selectors';
import { sessionViewScope } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { activateTerminal, sendTerminalSequence } from '../terminal/terminal-commands';
import { focusTerminalById, whenTerminalAttached } from '../terminal/terminal-pane-handlers';
import { getActivePaneId, getActivePaneTab } from '../workbench/pane-actions';
import { editorStatusKey, useEditorStatusStore } from './editor-status';
import { chooseReferenceTerminal, formatFileReference } from './file-reference';
import { getDiffEditorFileSelection } from './git-diff-actions';

/**
 * Upper bound for a just-revealed Terminal pane to mount and attach before the reference is abandoned.
 */
const TERMINAL_ATTACH_TIMEOUT_MS = 3000;

interface ActiveFileReference {
    endLine: number;
    /**
     * Absolute path of the real file the active editor describes, which for a diff tab is resolved from its repository
     * rather than taken from the virtual tab path.
     */
    path: string;
    session: SessionRecord;
    startLine: number;
}

/**
 * Reference for a Git diff tab, whose virtual path names a comparison rather than a file.
 *
 * The line comes from the mounted diff editor's caret: a diff surface owns per-instance comparison models and publishes
 * nothing to the editor status store, so the position exists only in the diff action registry. Resolving the repository
 * root here also keeps a submodule or linked worktree addressed by its own root instead of the Project root.
 *
 * Every single-file comparison qualifies, including a commit or pull-request tab. Those render a past revision, so the
 * caret line can address different code in the checkout; issue #1147 accepts that: a reader asking about the line in
 * front of them is better served by a reference that may need adjusting than by a command that silently does nothing.
 * The multi-file `changes` tab still declines, because it names no single file.
 */
function activeGitDiffReference(
    session: SessionRecord,
    tabPath: string,
): ActiveFileReference | undefined {
    const tab = parseGitDiffTab(tabPath);
    if (!tab || tab.kind === 'changes') return;
    const summary = queryClient.getQueryData<MethodResult<'git.summary'>>(
        caxriQueryKey('git.summary', { sessionId: session.id }),
    );
    const repo = summary?.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    // A file the working tree no longer has cannot be referenced by line, the same reason the toolbar disables its
    // Open Current File action.
    if (repo?.files.find((file) => file.path === tab.path)?.kind === 'deleted') return;
    const path = resolveRepoFilePath(repo?.rootPath, tab.path);
    if (!path) return;
    const paneId = getActivePaneId();
    const selection = paneId ? getDiffEditorFileSelection(tabPath, paneId) : undefined;
    return {
        endLine: selection?.selectionEndLine ?? selection?.line ?? 1,
        path,
        session,
        startLine: selection?.selectionStartLine ?? selection?.line ?? 1,
    };
}

function activeFileReference(): ActiveFileReference | undefined {
    const session = getSelectedSession();
    const active = getActivePaneTab();
    if (!session || active?.resource.kind !== 'file') return;
    const tabPath = active.resource.path;
    if (isVirtualEditorTabPath(tabPath)) return activeGitDiffReference(session, tabPath);
    const scope = sessionViewScope(session.id, session.workbenchProjectId);
    const status = useEditorStatusStore.getState().statuses[editorStatusKey(scope, tabPath)];
    const line = status?.line ?? 1;
    return {
        endLine: status?.selectionEndLine ?? line,
        path: tabPath,
        session,
        startLine: status?.selectionStartLine ?? line,
    };
}

/**
 * Gate for `editor.sendReferenceToTerminal`: the active editor describes a real file and its Session owns a Terminal.
 */
export function canSendActiveFileReference(): boolean {
    const reference = activeFileReference();
    if (!reference) return false;
    const bootstrap = getBootstrap();
    return Boolean(
        bootstrap &&
        chooseReferenceTerminal(
            bootstrap.terminals,
            reference.session.id,
            getSessionState()?.paneLayout,
        ),
    );
}

/**
 * Types `@path#L<line>` for the active editor's cursor (or selected line span) into the most recently opened Terminal
 * of the Session, then focuses that Terminal so the user can continue the prompt.
 *
 * The Terminal is revealed before the write because Server drops input for a Terminal without a mounted pane; the
 * reference is captured first so revealing the Terminal cannot change which editor it describes.
 */
export async function sendActiveFileReferenceToTerminal(): Promise<void> {
    const reference = activeFileReference();
    const bootstrap = getBootstrap();
    if (!reference || !bootstrap) return;
    const terminal = chooseReferenceTerminal(
        bootstrap.terminals,
        reference.session.id,
        getSessionState()?.paneLayout,
    );
    if (!terminal) {
        pushToast('error', 'Open a Terminal in this Session first');
        return;
    }
    const text = formatFileReference({
        path: reference.path,
        projectRoot: selectSelectedWorkbenchProject(bootstrap)?.rootPath,
        startLine: reference.startLine,
        endLine: reference.endLine,
    });
    activateTerminal(terminal.id);
    if (!(await whenTerminalAttached(terminal.id, TERMINAL_ATTACH_TIMEOUT_MS))) {
        pushToast('error', 'Terminal is not ready for input');
        return;
    }
    sendTerminalSequence(terminal.id, text);
    focusTerminalById(terminal.id);
}
