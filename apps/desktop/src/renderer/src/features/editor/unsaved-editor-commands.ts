import type { BootstrapState, ServerEvent } from '@caxri/protocol';
import { findResourceTabs, parseExternalEditorTab } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import type { SessionDocuments } from '@desktop-shared/editor-state';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap, getSessionState } from '../../stores/selectors';
import { sessionViewScope, useSessionViewStore } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { didSelectSession } from '../session/session-commands';
import { selectPaneTab } from '../workbench/pane-actions';
import { didSaveDocumentAt, openFile } from './document-commands';
import { isSavableEditorPath } from './document-write-commands';
import { focusEditor } from './editor-reveal';

type UnsavedEditorsRequest = Extract<ServerEvent, { event: 'editor.unsavedRequest' }>['payload'];

export interface UnsavedEditorDocument {
    sessionId: string;
    path: string;
    /**
     * False for a buffer retained under a Workbench Root the Session is not showing right now. `files.write` resolves
     * paths against the active root, so such a buffer cannot be saved until the user switches back to its root.
     */
    isActiveRoot: boolean;
}

const MAX_PROMPT_NAMES = 3;

/**
 * Every unsaved, savable Editor buffer across all Sessions, the selected Session first so Cancel reveals the tab the
 * user is most likely looking at.
 */
export function listUnsavedEditorDocuments(
    documents: SessionDocuments,
    bootstrap: Pick<BootstrapState, 'selectedSessionId' | 'sessions'> | undefined,
    activeScope: (sessionId: string) => string,
): UnsavedEditorDocument[] {
    if (!bootstrap) return [];
    const sessionIds = new Set(bootstrap.sessions.map(({ id }) => id));
    const unsaved = Object.entries(documents).flatMap(([scope, scoped]) => {
        const [sessionId] = scope.split('\0', 1);
        if (!sessionIds.has(sessionId)) return [];
        const isActiveRoot = activeScope(sessionId) === scope;
        return Object.values(scoped)
            .filter(
                (document) =>
                    document.dirty && !document.readOnly && isSavableEditorPath(document.path),
            )
            .map((document) => ({ sessionId, path: document.path, isActiveRoot }));
    });
    const rank = (entry: UnsavedEditorDocument): number =>
        (entry.sessionId === bootstrap.selectedSessionId ? 0 : 2) + (entry.isActiveRoot ? 0 : 1);
    return unsaved.toSorted((left, right) => rank(left) - rank(right));
}

export function unsavedEditorName(path: string): string {
    return parseExternalEditorTab(path)?.name ?? pathBasename(path);
}

/**
 * The names a prompt or toast lists for `paths`, at most `limit` of them. A name two unsaved files share (two
 * `index.ts` in different folders) gets its parent folder, so the user can tell which file the prompt means. Duplicates
 * are found across every path, not only the listed ones, because "index.ts and 2 more" is just as ambiguous when the
 * other `index.ts` is among the unlisted.
 */
export function unsavedEditorNames(paths: readonly string[], limit: number): string[] {
    const counts = new Map<string, number>();
    for (const path of paths) {
        const name = unsavedEditorName(path);
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return paths.slice(0, limit).map((path) => {
        const name = unsavedEditorName(path);
        if ((counts.get(name) ?? 0) < 2 || parseExternalEditorTab(path)) return name;
        const parent = pathBasename(path.slice(0, path.lastIndexOf('/')));
        return parent ? `${name} (${parent})` : name;
    });
}

/**
 * The toast shown when Save All stops at buffers kept under a Workbench Root the Session is not showing. It names the
 * files, so the user knows which root to switch back to. Main asks the same question before quitting and before closing
 * the window, so the advice names the dialog's own choice rather than either action.
 */
export function unreachableUnsavedEditorsMessage(paths: readonly string[]): string {
    const names = unsavedEditorNames(paths, MAX_PROMPT_NAMES);
    const more = paths.length - names.length;
    const separator = translate('editor.unsaved.listSeparator');
    const subject =
        more > 0
            ? translate('editor.unsaved.listMore', { names: names.join(separator), count: more })
            : names.length === 1
              ? names[0]
              : translate('editor.unsaved.listPair', {
                    names: names.slice(0, -1).join(separator),
                    last: names.at(-1) ?? '',
                });
    return translate(
        paths.length === 1 ? 'editor.unsaved.unreachableOne' : 'editor.unsaved.unreachableOther',
        { subject },
    );
}

function currentUnsavedEditorDocuments(): UnsavedEditorDocument[] {
    return listUnsavedEditorDocuments(
        useSessionViewStore.getState().documents,
        getBootstrap(),
        (sessionId) => sessionViewScope(sessionId),
    );
}

async function saveAllUnsavedEditors(): Promise<'inactiveRoot' | 'saved' | 'writeFailed'> {
    const unsaved = currentUnsavedEditorDocuments();
    const savable = unsaved.filter(({ isActiveRoot }) => isActiveRoot);
    for (const entry of savable) {
        // Sequential like a bulk tab close: stop at the first failure so its toast is the one the user reads.
        // eslint-disable-next-line no-await-in-loop -- intentional sequential save, see comment above
        if (!(await didSaveDocumentAt(entry.sessionId, entry.path))) return 'writeFailed';
    }
    const unreachable = unsaved.filter(({ isActiveRoot }) => !isActiveRoot).map(({ path }) => path);
    if (unreachable.length === 0) return 'saved';
    pushToast('error', unreachableUnsavedEditorsMessage(unreachable));
    return 'inactiveRoot';
}

async function revealFirstUnsavedEditor(): Promise<void> {
    const first = currentUnsavedEditorDocuments().at(0);
    if (!first) return;
    if (
        getBootstrap()?.selectedSessionId !== first.sessionId &&
        !(await didSelectSession(first.sessionId))
    )
        return;
    const layout = getSessionState()?.paneLayout;
    const tab = layout
        ? findResourceTabs(layout, { kind: 'file', path: first.path }).at(0)?.tab
        : undefined;
    if (!tab) {
        await openFile(first.path, { focus: true, preview: false });
        return;
    }
    selectPaneTab(tab.id);
    focusEditor(first.path);
}

/**
 * Answers Main's quit-time question about unsaved Editor buffers (issue caxri#1631). Only file names leave the
 * Renderer; buffer content and paths stay here.
 */
async function handleUnsavedEditorsRequest(request: UnsavedEditorsRequest): Promise<void> {
    if (request.action === 'reveal') {
        await revealFirstUnsavedEditor();
        return;
    }
    if (request.action === 'inspect') {
        const unsaved = currentUnsavedEditorDocuments();
        await caxri.request('editor.unsavedReply', {
            requestId: request.requestId,
            reply: {
                kind: 'summary',
                count: unsaved.length,
                names: unsavedEditorNames(
                    unsaved.map(({ path }) => path),
                    MAX_PROMPT_NAMES,
                ),
            },
        });
        return;
    }
    const outcome = await saveAllUnsavedEditors();
    await caxri.request('editor.unsavedReply', {
        requestId: request.requestId,
        reply: outcome === 'saved' ? { kind: 'saved' } : { kind: 'saveFailed', reason: outcome },
    });
}

/**
 * Listens for Main's quit-time questions for the lifetime of the Workbench window.
 */
export function subscribeUnsavedEditorRequests(): () => void {
    return caxri.onEvent((event) => {
        if (event.event !== 'editor.unsavedRequest') return;
        // Fire-and-forget: Main times out an unanswered request and fails open, and a failed save already surfaced its
        // own toast.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void handleUnsavedEditorsRequest(event.payload);
    });
}
