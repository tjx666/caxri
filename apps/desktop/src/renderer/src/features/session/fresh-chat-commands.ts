import type { TerminalKind } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { sessionsByEnvironment } from '../../lib/environment-routing';
import { queryClient } from '../../queries/client';
import { removeSessionQueries } from '../../queries/session-queries';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { clearPendingSession } from '../../stores/dialogs';
import { getBootstrap, selectSelectedProject } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { forgetDeletedSessions } from '../closed-items/recording';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import {
    rememberActivitySessionProject,
    resolveActivitySessionProject,
    useActivitySessionProjectStore,
} from './activity-session-project-store';
import {
    didClaimFreshChatSession,
    freshChatKind,
    markFreshChatSession,
} from './fresh-chat-session';
import { rememberLastAgentChoice, useLastAgentChoiceStore } from './last-agent-choice-store';
import { pressSplitNewSession } from './session-creation-commands';

/**
 * Creates a Chat Session and marks it fresh. Resolves its id, or `undefined` after a failure already reported in a
 * toast.
 */
function createFreshChat(projectId: string, kind: TerminalKind): Promise<string | undefined> {
    return tryCommand(
        translate('session.errors.createFailed'),
        async () => {
            const created = await caxri.request('session.create', {
                projectId,
                defaultAgent: kind,
                surface: 'chat',
            });
            clearPendingSession();
            markFreshChatSession(created.session.id);
            return created.session.id;
        },
        { refresh: refreshWorkbench },
    );
}

function currentFreshChatKind(): TerminalKind | undefined {
    const settings = getBootstrap()?.settings;
    return freshChatKind(
        settings?.['session.defaultAgent'],
        settings?.['session.openAgentsInChat'],
        useLastAgentChoiceStore.getState().kind,
    );
}

/**
 * The Activity view's New Session press, and `⌘N` while Activity shows: opens a fresh Chat right away instead of a
 * menu, so the user can start typing; the Project and Agent stay changeable in the empty Chat until the first message.
 * Without an Agent that can open in Chat it keeps the split press's existing behavior.
 */
export function startActivitySession(projectId: string): void {
    const kind = currentFreshChatKind();
    if (!kind) {
        pressSplitNewSession(projectId, 'activity');
        return;
    }
    // Fire-and-forget: `createFreshChat` funnels its own failures into a toast via `tryCommand`.
    void createFreshChat(projectId, kind);
}

/**
 * `⌘N` (and the other `session.create` entries) while the Primary Side Bar shows Activity: the same fresh Chat as the
 * row's press, in the Project the row names. Answers `false` outside Activity, with no Project, or with no Agent that
 * opens in Chat, so the caller keeps its existing behavior (the command keeps "Ask each time" literal).
 */
export function didStartFreshChatFromCommand(): boolean {
    if (!useChromeLayoutStore.getState().primarySidebarActivityMode) return false;
    const bootstrap = getBootstrap();
    const project = resolveActivitySessionProject(
        topLevelProjects(bootstrap?.projects ?? []),
        useActivitySessionProjectStore.getState().projectId,
        selectSelectedProject(bootstrap)?.id,
    );
    const kind = currentFreshChatKind();
    if (!project || !kind) return false;
    // Fire-and-forget: `createFreshChat` funnels its own failures into a toast via `tryCommand`.
    void createFreshChat(project.id, kind);
    return true;
}

/**
 * Asks Server Core to delete `sessionId` if it is still an untouched Chat. The Server decides, so a Session that
 * received a message in the meantime always stays. Answers whether it was discarded.
 */
async function wasDiscardedIfEmpty(sessionId: string): Promise<boolean> {
    const [[environmentId] = [undefined]] = sessionsByEnvironment([sessionId]);
    const { discarded } = await caxri
        .in(environmentId)
        .request('session.discardIfEmpty', { sessionId });
    if (!discarded) return false;
    useSessionViewStore.getState().dropSessions([sessionId]);
    forgetDeletedSessions([sessionId]);
    removeSessionQueries(queryClient, [sessionId]);
    await refreshWorkbench();
    return true;
}

/**
 * Moves a fresh Chat to another Project or Agent before its first message: a new fresh Chat opens there and the old one
 * is discarded quietly (the user did not leave it, they replaced it). The choice is remembered like a pick from the New
 * Session list. A failed creation keeps the old Chat fresh.
 */
export function moveFreshChat(
    sessionId: string,
    target: { projectId: string; kind: TerminalKind },
): void {
    if (!didClaimFreshChatSession(sessionId)) return;
    rememberActivitySessionProject(target.projectId);
    rememberLastAgentChoice(target.kind);
    void (async () => {
        const created = await createFreshChat(target.projectId, target.kind);
        if (!created) {
            markFreshChatSession(sessionId);
            return;
        }
        await tryCommand(translate('session.errors.deleteFailed'), () =>
            wasDiscardedIfEmpty(sessionId),
        );
    })();
}

/**
 * Leaving a fresh Chat that never received a message discards it, with a toast saying so, so the queue never fills with
 * empty "Untitled" rows.
 */
export function discardFreshChatOnLeave(sessionId: string): void {
    if (!didClaimFreshChatSession(sessionId)) return;
    void tryCommand(translate('session.errors.deleteFailed'), async () => {
        if (await wasDiscardedIfEmpty(sessionId))
            pushToast('success', translate('session.freshChat.discarded'));
    });
}
