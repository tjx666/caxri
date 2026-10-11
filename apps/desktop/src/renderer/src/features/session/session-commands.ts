import type {
    MethodResult,
    ProjectRecord,
    SessionPullRequest,
    SessionRestorePlacement,
    TerminalRecord,
} from '@caxri/protocol';

import type { SessionMruShortcutInvocation } from '../../commands/registry';
import { caxri } from '../../lib/caxri';
import { copyFilePath } from '../../lib/copy-file-path';
import { openExternalUrl } from '../../lib/external-link';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { removeSessionQueries } from '../../queries/invalidation';
import { useDialogStore } from '../../stores/dialogs';
import { getBootstrap, getSelectedSession, selectSelectedProject } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { pushToast, tryCommand } from '../../stores/toasts';
import {
    refreshWorkbench,
    registerSessionCommandConvergence,
    showSessionTitle,
} from '../../stores/workbench';
import {
    beginPendingSessionTitle,
    settlePendingSessionTitle,
} from '../../stores/workbench-session-titles';
import { beginRendererPerformanceRequest } from '../renderer-performance/controller';
import { requestPinnedSessionReveal } from './pinned-session-reveal';
import { activeSessionsInSidebarOrder } from './session-activity-order';
import type { PendingSessionMruSelection } from './session-mru-switcher-state';
import {
    resolveSessionMruNavigation,
    useSessionMruSwitcherStore,
} from './session-mru-switcher-state';
import type { SessionNavigationDirection } from './session-navigation-history';
import { useSessionNavigationHistoryStore } from './session-navigation-history';

const mruNavigationState: { pendingSelection?: PendingSessionMruSelection } = {};

/**
 * `session.select` publishes a full `state.changed` event before returning its result. That event is the convergence
 * path; register before sending so delayed Preload event replay still settles history after the event-driven snapshot,
 * without queueing a second full `app.bootstrap` behind it.
 */
async function didRequestSelection(sessionId: string): Promise<boolean> {
    const convergence = registerSessionCommandConvergence('session.select');
    const finishPerformanceRequest = beginRendererPerformanceRequest('session.select');
    const selected = await tryCommand('Session selection failed', async () => {
        try {
            return await caxri.request('session.select', { sessionId });
        } finally {
            finishPerformanceRequest();
        }
    });
    if (selected === undefined) {
        convergence.cancel();
        return false;
    }
    await convergence.promise;
    return true;
}

/**
 * Every Session selection the Renderer issues, history navigation aside, reports itself to the visit history. Leaving
 * that to the observed Workbench snapshot cannot work: the snapshot carries no attribution, so a selection that races a
 * history navigation is indistinguishable from that navigation's own echo.
 */
async function didRequestSessionSelection(sessionId: string): Promise<boolean> {
    useSessionNavigationHistoryStore.getState().beginSelection();
    const selected = await didRequestSelection(sessionId);
    useSessionNavigationHistoryStore.getState().settleSelection(sessionId, selected);
    return selected;
}

export async function didSelectSession(sessionId: string): Promise<boolean> {
    delete mruNavigationState.pendingSelection;
    return didRequestSessionSelection(sessionId);
}

/**
 * "Open" for a Session row's activation gesture. Double-click opens the thing under the pointer in Finder, in the VS
 * Code explorer, and on this app's own Workbench tab strip, so a Session row must not spend that gesture on rename;
 * rename stays on the row's context menu and its Enter key.
 *
 * A Session owns the entire Workbench, so opening one is selecting it; there is no second surface to raise. A row that
 * is already selected is therefore already open, and re-issuing `session.select` for it would push a redundant
 * selection into the visit history for a gesture that changed nothing.
 */
export function openSession(sessionId: string): void {
    if (getBootstrap()?.selectedSessionId === sessionId) return;
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didSelectSession(sessionId);
}

/**
 * Records the logical selection synchronously so another quick-toggle can reverse direction before Server's full
 * snapshot refresh completes. Server remains authoritative: the pending link disappears when its refreshed selected
 * Session arrives, and a failed request or any ordinary Session selection clears it.
 */
function selectMruSession(sessionId: string): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const navigation = resolveSessionMruNavigation(
        bootstrap.sessions,
        bootstrap.selectedSessionId,
        mruNavigationState.pendingSelection,
    );
    const previousSessionId = navigation.selectedSessionId;
    if (!previousSessionId || previousSessionId === sessionId) return;
    mruNavigationState.pendingSelection = { currentSessionId: sessionId, previousSessionId };
    // Fire-and-forget: the request funnels failures into a toast and completion only reconciles optimistic MRU data.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didRequestSessionSelection(sessionId).then((selected) => {
        if (mruNavigationState.pendingSelection?.currentSessionId !== sessionId) return;
        if (!selected || getBootstrap()?.selectedSessionId === sessionId)
            delete mruNavigationState.pendingSelection;
    });
}

export function selectProject(projectId: string): void {
    const bootstrap = getBootstrap();
    const session = bootstrap
        ? activeSessionsInSidebarOrder(bootstrap.projects, bootstrap.sessions).find(
              (item) => item.projectId === projectId,
          )
        : undefined;
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    if (session) void didSelectSession(session.id);
}

export async function didReorderProject(projectId: string, targetIndex: number): Promise<boolean> {
    const reordered = await tryCommand('Project reordering failed', () =>
        caxri.request('project.reorder', { projectId, targetIndex }),
    );
    return reordered !== undefined;
}

export async function didReorderSession(
    sessionId: string,
    anchorSessionId: string,
    placement: 'before' | 'after',
): Promise<boolean> {
    const convergence = registerSessionCommandConvergence('session.reorder');
    const reordered = await tryCommand('Session reordering failed', () =>
        caxri.request('session.reorder', { sessionId, anchorSessionId, placement }),
    );
    if (reordered === undefined) {
        convergence.cancel();
        return false;
    }
    await convergence.promise;
    return true;
}

/**
 * Reorders the Pinned group. Separate from `didReorderSession` because the two move the same Session in two different
 * lists: this one writes the Pinned order and leaves the Session exactly where it is inside its own Project group.
 */
export async function didReorderPinnedSession(
    sessionId: string,
    anchorSessionId: string,
    placement: 'before' | 'after',
): Promise<boolean> {
    const convergence = registerSessionCommandConvergence('session.reorderPinned');
    const reordered = await tryCommand('Pinned Session reordering failed', () =>
        caxri.request('session.reorderPinned', { sessionId, anchorSessionId, placement }),
    );
    if (reordered === undefined) {
        convergence.cancel();
        return false;
    }
    await convergence.promise;
    return true;
}

/**
 * Longest Session title a lifecycle notice quotes. Titles are user- and Agent-authored and effectively unbounded, so a
 * runaway one would push the notice's own verb and its action button out of the toast's fixed width.
 */
const SESSION_NOTICE_TITLE_MAX_LENGTH = 48;

/**
 * Copy for a notice that records one Session lifecycle change. An empty `displayTitle` is representable in the Session
 * record (a Shell-only Session has no Agent to name it) and quoting nothing reads as a rendering bug, so that case
 * names the noun instead of the title.
 */
function describeSessionNotice(verb: string, displayTitle: string | undefined): string {
    const title = displayTitle?.trim() ?? '';
    if (title.length === 0) return `${verb} Session`;
    // Count and cut by code point: an Agent-authored title can end on an emoji, and a UTF-16 cut would leave a lone
    // surrogate that renders as the replacement character.
    const characters = [...title];
    if (characters.length <= SESSION_NOTICE_TITLE_MAX_LENGTH) return `${verb} "${title}"`;
    const head = characters.slice(0, SESSION_NOTICE_TITLE_MAX_LENGTH).join('').trimEnd();
    return `${verb} "${head}…"`;
}

export function describeArchivedSession(displayTitle: string | undefined): string {
    return describeSessionNotice('Archived', displayTitle);
}

/**
 * Restore's counterpart to {@link describeArchivedSession}. Archive and restore are one reversible pair, so they report
 * themselves in one shape; a restore that announced nothing was the only Session state change with no record at all,
 * and it happens inside a dialog large enough to cover the PrimarySidebar row it just brought back.
 */
export function describeRestoredSession(displayTitle: string | undefined): string {
    return describeSessionNotice('Restored', displayTitle);
}

/**
 * Copy for a batch restore. Quoting a batch is not possible in a toast's width, so the count carries the record; a
 * single-Session batch still names its Session, because there the title is the useful part.
 */
export function describeRestoredSessions(displayTitles: ReadonlyArray<string | undefined>): string {
    if (displayTitles.length === 1) return describeRestoredSession(displayTitles[0]);
    return `Restored ${displayTitles.length} Sessions`;
}

/**
 * Archiving deliberately skips a confirmation because it is reversible, but the Archived Sessions dialog it relies on
 * is reachable only through the PrimarySidebar footer entry, which `Command+[` hides entirely, and the `Delete`
 * keyboard path reports nothing at all on its own. The notice is therefore the state-change record for both the hover
 * button and the keyboard shortcut, it carries the reversal inline so the escape hatch never depends on finding that
 * dialog, and Sonner's live region gives the keyboard path its screen-reader announcement. It stays an ordinary
 * four-second toast: `persist` is reserved for events that already cost the user something irreversible.
 */
async function archiveSessionWithNotice(sessionId: string): Promise<void> {
    const archived = await tryCommand(
        'Session archive failed',
        () => caxri.request('session.archive', { sessionId }),
        { refresh: refreshWorkbench },
    );
    if (!archived) return;
    pushToast('info', describeArchivedSession(archived.displayTitle), {
        /**
         * The notice outlives the row it describes, and now outlives the toast as well: the offer is still in the
         * notification center after the Session has been deleted or the window navigated elsewhere. `unarchiveSession`
         * runs the request through `tryCommand`, so a stale Undo reports one error toast instead of throwing out of the
         * click handler. The handler restores with `unchanged`, so the row returns to the position it was archived
         * from, not to the top of the Project the way an explicit restore does. One thing Undo deliberately does not
         * put back is the pin: archiving clears it, and restoring it here would resurrect a Pinned row the user may
         * have stopped watching weeks ago. They pin it again if they still want it there.
         */
        action: {
            id: 'session.unarchive',
            params: { sessionId },
            // Several archived Sessions leave several `Undo` buttons in the history, identical to a screen reader
            // reading the buttons alone. The title says which one this is.
            accessibleLabel: `Undo archiving ${archived.displayTitle}`,
        },
    });
}

export function archiveSession(sessionId: string): void {
    // Fire-and-forget: `archiveSessionWithNotice` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void archiveSessionWithNotice(sessionId);
}

export function archiveSelectedSession(): void {
    const session = getSelectedSession();
    if (session) archiveSession(session.id);
}

/**
 * Pins or unpins one Session. No toast: unlike archiving, the result is a row appearing or disappearing at the top of
 * the Primary Side Bar, which the user is looking at and can reverse with the same control they just used. A pin also
 * asks the sidebar to reveal the row and announce it (`requestPinnedSessionReveal`), because the new row joins the end
 * of the Pinned order and can land below the group's window, where nothing on screen would show it happened.
 */
export function setSessionPinned(sessionId: string, shouldPin: boolean): void {
    // Fire-and-forget: `tryCommand` funnels its own failures into a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        shouldPin ? 'Pin Session failed' : 'Unpin Session failed',
        () => caxri.request('session.setPinned', { sessionId, pinned: shouldPin }),
        { refresh: refreshWorkbench },
    ).then((pinned) => {
        if (shouldPin && pinned) requestPinnedSessionReveal(sessionId);
    });
}

/**
 * Opens the Archived Sessions manager. Its only other entry point is the Primary Side Bar footer button, which
 * `Command+[` hides along with the rest of the side bar.
 */
export function openArchivedSessions(): void {
    useDialogStore.getState().setArchivedSessionsOpen(true);
}

/**
 * Codex refuses to open one conversation in two processes, so handing a Session to an editor Terminal means Caxri must
 * stop its own Agent first. `session.detach` parks the Agent Terminals as `detached`; unlike background suspension,
 * selecting the Session again does not relaunch them; only `resumeSession` does.
 */
export function detachSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Session detach failed', () => caxri.request('session.detach', { sessionId }), {
        refresh: refreshWorkbench,
    });
}

export function resumeSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Session resume failed', () => caxri.request('session.resume', { sessionId }), {
        refresh: refreshWorkbench,
    });
}

export function detachSelectedSession(): void {
    const session = getSelectedSession();
    if (session) detachSession(session.id);
}

export function resumeSelectedSession(): void {
    const session = getSelectedSession();
    if (session) resumeSession(session.id);
}

/**
 * Acknowledges one attention generation. Rejection is the caller's to handle: the same generation stays unread on the
 * Server, so the next focus or visibility event can retry it without the Renderer tracking anything of its own.
 */
export async function markSessionRead(sessionId: string, attentionEpoch: number): Promise<void> {
    await caxri.request('session.markRead', { sessionId, attentionEpoch });
}

/**
 * The Server sweep owns delivery-CLI pacing per Session; the PrimarySidebar poll only asks for the latest projection at
 * this cadence, and the `sessionPullRequests.changed` event refetches early when a sweep changes something. The palette
 * uses the same number as its `staleTime`, so a hidden sidebar still leaves the palette self-refreshing at that rate.
 */
export const SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS = 60_000;

/**
 * The Session's pull request as the PrimarySidebar last learned it. Read from the shared query cache rather than
 * refetched: the sidebar polls `session.pullRequests` for every row, so the palette and row menu answer from the same
 * snapshot the glyph is drawn from and never race a second lookup against it.
 */
function cachedSessionPullRequest(sessionId: string): SessionPullRequest | undefined {
    return queryClient.getQueryData<MethodResult<'session.pullRequests'>>(
        caxriQueryKey('session.pullRequests', undefined),
    )?.pullRequests[sessionId];
}

/**
 * Keyboard-reachable route to the pull request the hover card links. The card is a non-modal preview that never
 * receives focus: Tab from the row leaves the sidebar, so the row menu and the palette own this entry.
 */
export function openSessionPullRequest(pullRequest: Pick<SessionPullRequest, 'url'>): void {
    // Fire-and-forget: `openExternalUrl` reports its own failure through the toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void openExternalUrl(pullRequest.url, (message) => pushToast('error', message));
}

export function openSelectedSessionPullRequest(): void {
    const session = getSelectedSession();
    const pullRequest = session && cachedSessionPullRequest(session.id);
    if (pullRequest) openSessionPullRequest(pullRequest);
}

/**
 * The Agent's own conversation identifier (a Codex thread id, a Claude Code session id), which is not Caxri's Session
 * row id. Provider CLIs and their on-disk state are keyed by this value, so it is what lines a Session up against
 * `codex resume`, a rollout file, or a `~/.claude/projects` transcript when an Agent binding has to be inspected.
 */
export function copyAgentSessionId(agentSessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Unable to copy the Agent Session ID', async () => {
        await navigator.clipboard.writeText(agentSessionId);
        pushToast('success', 'Agent Session ID copied');
    });
}

/**
 * Resolves the transcript path on click rather than subscribing every Session row to a transcript query: Codex names
 * its rollout files by wall-clock time, so the Server answers by scanning its sessions directory, and the sidebar
 * renders one menu per row. `withContent: false` keeps that lookup off the file's contents.
 */
export function copyAgentTranscriptPath(terminalId: string): void {
    // Fire-and-forget: `tryCommand` funnels the failure into a toast internally, and `copyFilePath` reports its own.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Unable to copy the transcript path', async () => {
        const transcript = await caxri.request('terminal.agentTranscript', {
            terminalId,
            withContent: false,
        });
        if (!transcript) throw new Error('This Agent keeps no on-disk transcript');
        await copyFilePath(transcript.path);
    });
}

/**
 * True when the Session has at least one Agent Terminal parked by `detachSession`, i.e. the menu should offer Resume
 * instead of Detach.
 */
export function hasDetachedAgentTerminal(
    sessionId: string,
    terminals: ReadonlyArray<Pick<TerminalRecord, 'lastProcessState' | 'provider' | 'sessionId'>>,
): boolean {
    return terminals.some(
        (terminal) =>
            terminal.sessionId === sessionId &&
            terminal.provider !== undefined &&
            terminal.lastProcessState === 'detached',
    );
}

/**
 * True when the Session has a live Agent Terminal that `detachSession` could hand over.
 */
export function hasLiveAgentTerminal(
    sessionId: string,
    terminals: ReadonlyArray<Pick<TerminalRecord, 'lastProcessState' | 'provider' | 'sessionId'>>,
): boolean {
    return terminals.some(
        (terminal) =>
            terminal.sessionId === sessionId &&
            terminal.provider !== undefined &&
            (terminal.lastProcessState === 'running' || terminal.lastProcessState === 'starting'),
    );
}

async function unarchiveSessionWithNotice(
    sessionId: string,
    placement: SessionRestorePlacement,
): Promise<void> {
    const restored = await tryCommand(
        'Session restore failed',
        () => caxri.request('session.unarchive', { placement, sessionId }),
        { refresh: refreshWorkbench },
    );
    /**
     * `unchanged` is the archive notice's Undo, and only that. It already named the Session it was reversing one toast
     * ago, and it restores the row into a PrimarySidebar the user can see, so a second notice would report a change
     * they just watched happen. An explicit restore has neither: it is issued from a dialog wide enough to cover the
     * sidebar, so without this the row reappears somewhere the user cannot see and nothing says so.
     */
    if (!restored || placement === 'unchanged') return;
    pushToast('info', describeRestoredSession(restored.displayTitle));
}

/**
 * Restoring puts the Session back on top of its Project by default, so the row the user just asked for is the one they
 * see. Only the archive notice's Undo passes `unchanged`: it reverses a single archive, and a row that jumped to the
 * top would have rewritten the order the user arranged by dragging.
 */
export function unarchiveSession(
    sessionId: string,
    placement: SessionRestorePlacement = 'top',
): void {
    // Fire-and-forget: `unarchiveSessionWithNotice` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void unarchiveSessionWithNotice(sessionId, placement);
}

/**
 * Bulk restore from the Archived Sessions manager: one request, one bootstrap refresh, regardless of batch size. The
 * batch lands on top of its Projects in the order given, so the dialog's first row stays the first row afterwards.
 */
async function unarchiveSessionsWithNotice(sessionIds: readonly string[]): Promise<void> {
    const restored = await tryCommand(
        'Session restore failed',
        () =>
            caxri.request('session.unarchiveMany', {
                placement: 'top',
                sessionIds: [...sessionIds],
            }),
        { refresh: refreshWorkbench },
    );
    // Reports what the Server actually restored rather than what was requested: a stale selection can name a Session
    // that was deleted between opening the dialog and pressing Restore.
    if (!restored || restored.length === 0) return;
    pushToast('info', describeRestoredSessions(restored.map((session) => session.displayTitle)));
}

export function unarchiveSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    // Fire-and-forget: `unarchiveSessionsWithNotice` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void unarchiveSessionsWithNotice(sessionIds);
}

/**
 * The new name shows at once: a Claude rename waits seconds for the provider CLI before the Server commits it. When the
 * newest rename fails, the previous name comes back alongside the failure toast.
 */
export async function didRenameSession(sessionId: string, displayTitle: string): Promise<boolean> {
    const currentTitle = getBootstrap()?.sessions.find(({ id }) => id === sessionId)?.displayTitle;
    const attempt = beginPendingSessionTitle(sessionId, displayTitle, currentTitle ?? displayTitle);
    showSessionTitle(sessionId, displayTitle);
    const renamed = await tryCommand(
        'Session rename failed',
        () => caxri.request('session.rename', { sessionId, displayTitle }),
        { refresh: refreshWorkbench },
    );
    const restoredTitle = settlePendingSessionTitle(sessionId, attempt, renamed !== undefined);
    if (restoredTitle !== undefined) {
        showSessionTitle(sessionId, restoredTitle);
        await refreshWorkbench();
    }
    return renamed !== undefined;
}

export function openSelectedProjectInExternalEditor(): void {
    const bootstrap = getBootstrap();
    const project = selectSelectedProject(bootstrap);
    if (!bootstrap || !project) return;
    const session = getSelectedSession();
    openProjectInExternalEditor(
        project,
        session?.projectId === project.id ? session.id : undefined,
    );
}

export function openProjectInExternalEditor(
    project: Pick<ProjectRecord, 'id' | 'rootPath'>,
    sessionId?: string,
): void {
    /**
     * A Session row is grouped under its owning Project, while its Files/Editor/Git root may be a linked Workbench
     * Project. Resolve the target from that Session binding so Server Core authorizes the same root it uses for the
     * request; sending the owner root with a worktree Session is rejected as outside the selected Project root.
     */
    const bootstrap = getBootstrap();
    const session = sessionId
        ? bootstrap?.sessions.find((candidate) => candidate.id === sessionId)
        : undefined;
    const workbenchProject = session
        ? bootstrap?.projects.find((candidate) => candidate.id === session.workbenchProjectId)
        : undefined;
    const targetProject = workbenchProject ?? project;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Opening the Project in the external editor failed', () =>
        sessionId === undefined
            ? caxri.request('project.openRoot', { projectId: project.id, application: 'editor' })
            : caxri.request('project.openInEditor', {
                  path: targetProject.rootPath,
                  sessionId,
              }),
    );
}

export function deleteSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Session deletion failed', async () => {
        const result = await caxri.request('session.delete', { sessionId });
        if ('canceled' in result) return;
        useSessionViewStore.getState().dropSessions([sessionId]);
        removeSessionQueries(queryClient, [sessionId]);
        await refreshWorkbench();
    });
}

/**
 * Bulk deletion from the Archived Sessions manager. Desktop Main shows one native confirmation for the whole batch, so
 * a canceled result means nothing was deleted.
 */
export function deleteSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Session deletion failed', async () => {
        const result = await caxri.request('session.deleteMany', { sessionIds: [...sessionIds] });
        if ('canceled' in result) return;
        useSessionViewStore.getState().dropSessions([...sessionIds]);
        removeSessionQueries(queryClient, [...sessionIds]);
        await refreshWorkbench();
    });
}

export function deleteSelectedSession(): void {
    const session = getSelectedSession();
    if (!session) return;
    deleteSession(session.id);
}

/**
 * Moves a live Terminal (its PTY untouched) into a brand-new Session under the same Project, then switches to it,
 * analogous to a browser "move tab to new window". The Server already selects the new Session as part of the same
 * operation, so the post-command bootstrap refresh is all that is needed to reflect the switch, matching
 * `session.create`'s flow. The only-tab constraint is repeated at this request boundary so an accessibility or
 * synthetic activation of a disabled menu item cannot reach the Server.
 */
export function moveTerminalToNewSession(terminalId: string, isOnlyWorkTab = false): void {
    if (isOnlyWorkTab) return;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Move to new session failed',
        () => caxri.request('terminal.moveToNewSession', { terminalId }),
        { refresh: refreshWorkbench },
    );
}

export function selectAdjacentSession(delta: 1 | -1): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const activeSessions = activeSessionsInSidebarOrder(bootstrap.projects, bootstrap.sessions);
    if (activeSessions.length === 0) return;
    const selectedIndex = activeSessions.findIndex(
        (session) => session.id === getSelectedSession()?.id,
    );
    if (selectedIndex === -1) return;
    const next =
        activeSessions[(selectedIndex + delta + activeSessions.length) % activeSessions.length];
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didSelectSession(next.id);
}

export function switchMruSession(invocation?: SessionMruShortcutInvocation): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const navigation = resolveSessionMruNavigation(
        bootstrap.sessions,
        bootstrap.selectedSessionId,
        mruNavigationState.pendingSelection,
    );
    mruNavigationState.pendingSelection = navigation.pendingSelection;
    const immediateSessionId = useSessionMruSwitcherStore
        .getState()
        .beginOrCycle(navigation.candidateIds, invocation);
    // A command-palette invocation, or a binding with no held modifier, is a one-shot jump to the previous Session.
    if (immediateSessionId) selectMruSession(immediateSessionId);
}

/**
 * Walks the Session visit history, browser-style. The history stack is device-local and in-memory: it describes this
 * window's navigation, not persisted Session state, so a relaunch legitimately starts with an empty stack.
 */
export function navigateSessionHistory(direction: SessionNavigationDirection): void {
    const request = useSessionNavigationHistoryStore.getState().request(direction);
    if (!request) return;
    delete mruNavigationState.pendingSelection;
    // Fire-and-forget: `didRequestSelection` funnels its own failures into a toast via `tryCommand`; the only thing
    // left to do here is report the outcome back, so the history moves only for a navigation that actually happened.
    // The request already registered itself with the history, which is why this does not go through
    // `didRequestSessionSelection`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didRequestSelection(request.target).then((selected) => {
        const history = useSessionNavigationHistoryStore.getState();
        if (selected) history.confirm(request);
        else history.abandon(request);
    });
}

export function canNavigateSessionHistory(direction: SessionNavigationDirection): boolean {
    const history = useSessionNavigationHistoryStore.getState();
    return direction === 'back' ? history.canGoBack : history.canGoForward;
}

export function commitMruSession(): void {
    const state = useSessionMruSwitcherStore.getState();
    const sessions = getBootstrap()?.sessions ?? [];
    const availableCandidateIds = state.candidateIds.filter((id) =>
        sessions.some((session) => session.id === id && session.archivedAt === undefined),
    );
    const sessionId = state.commit(availableCandidateIds);
    if (sessionId) selectMruSession(sessionId);
}
