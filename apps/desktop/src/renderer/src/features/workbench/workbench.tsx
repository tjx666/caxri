import { useEffect, useMemo, useState } from 'react';

import { isChatTerminal, listPaneTerminalIds } from '@caxri/protocol';
import { X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useDialogStore } from '../../stores/dialogs';
import { useSelectedSession } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { retainAgentChatComposerState } from '../agent-chat/composer-input/agent-chat-drafts';
import { useReportViewedSession } from '../session/hooks/use-report-viewed-session';
import { SettingsWorkbenchPage } from '../settings/settings-workbench-page';
import { retainTerminalProgress } from '../terminal/terminal-progress';
import { reconcileSessionAnimations } from './hidden-session-transitions';
import { PaneView } from './pane-view';
import { useSessionFocusHandoff } from './session-focus-handoff';
import {
    pruneKeepAliveSessions,
    retainKeepAliveSession,
    SESSION_KEEP_ALIVE_LIMIT,
    useSessionKeepAliveStore,
} from './session-keep-alive';
import { WelcomeView } from './welcome-view';

/**
 * What the Workbench shows with no selected Session. Settings is normally a Session pane tab
 * (`settings-tab-opener.ts`), but before the first Project exists there is no pane to open it into, and dropping the
 * request would leave a first-run user with no way to reach Settings at all. So a Settings request made in this state
 * replaces the Welcome view with the same Settings page until the user closes it (the button or `Cmd+W`, through
 * `workbench.closeActiveTab`); requests made before this view mounted (a Session was selected then) were already
 * answered by a tab and do not reopen it here.
 */
function NoSessionSurface() {
    const { t } = useTranslation();
    const requestId = useDialogStore((state) => state.settingsRequest.id);
    const dismissedId = useDialogStore((state) => state.sessionlessSettingsDismissedId);
    const [mountedRequestId] = useState(requestId);
    if (requestId <= Math.max(mountedRequestId, dismissedId)) return <WelcomeView />;
    return (
        <div className="h-full min-h-0">
            <SettingsWorkbenchPage
                headerAction={
                    <Tooltip content={t('workbench.closeSettings')}>
                        <Button
                            aria-label={t('workbench.closeSettings')}
                            size="icon"
                            variant="ghost"
                            onClick={() => useDialogStore.getState().dismissSessionlessSettings()}
                        >
                            <X size={14} />
                        </Button>
                    </Tooltip>
                }
            />
        </div>
    );
}

/**
 * The Workbench is the pane tree of the selected Session: there is no Terminal-versus-Editor surface switch, because
 * every tab lives in the bar of the pane that holds it. Each retained Workbench is keyed by its Session ID and reads
 * only that Session's state, so switching Sessions re-renders the incoming and outgoing Workbench, never the others.
 *
 * It holds one `PaneView` per recently used Session rather than only the selected one. Rebuilding the tree on every
 * switch meant tearing down and re-creating every xterm, re-attaching WebGL, and replaying the Server snapshot, which
 * the user saw as the Terminal flashing and losing its scroll position (issue #657). The retained Sessions stay mounted
 * and hidden; only the visible one holds GPU contexts and answers focus recovery.
 */
export function Workbench() {
    const session = useSelectedSession();
    const selectedSessionId = session?.id;
    const storedRetained = useSessionKeepAliveStore((state) => state.retained);
    /**
     * Derived for this render, committed to the store right after. Reading the store alone would render one frame in
     * which the newly selected Session is not retained yet (every Workbench hidden, the user looking at nothing) and
     * writing to an external store during render is not safe, so the promotion happens in both places rather than one.
     */
    const retained = useMemo(
        () =>
            selectedSessionId && storedRetained[0] !== selectedSessionId
                ? [
                      selectedSessionId,
                      ...storedRetained.filter((id) => id !== selectedSessionId),
                  ].slice(0, SESSION_KEEP_ALIVE_LIMIT)
                : storedRetained,
        [selectedSessionId, storedRetained],
    );
    useEffect(() => {
        retainKeepAliveSession(selectedSessionId);
    }, [selectedSessionId]);
    useSessionFocusHandoff(selectedSessionId);
    useReportViewedSession(selectedSessionId);
    const liveSessionKey = useWorkbenchStore(
        (state) => state.bootstrap?.sessions.map(({ id }) => id).join('\u{0}') ?? '',
    );
    useEffect(() => {
        pruneKeepAliveSessions(new Set(liveSessionKey ? liveSessionKey.split('\u{0}') : []));
    }, [liveSessionKey]);
    /**
     * Retained once for every mounted Session, not per `PaneView`: `retainTerminalProgress` drops every Terminal
     * outside the set it is given, so one call per Workbench would have the visible Session clearing the progress
     * badges of the Sessions kept alive behind it.
     */
    const retainedIds = useMemo(() => new Set(retained), [retained]);
    /**
     * DOM order of the retained Workbenches. `retained` is most recently used first, so rendering it directly had React
     * move a Workbench node on almost every switch, and moving a node resets the scroll offset of everything inside it:
     * a Chat the user had scrolled up came back at its top, and one following the latest reply visibly re-scrolled to
     * the end. Any order in which two retained Sessions never swap works; with id order, admitting or evicting a
     * Session only inserts or removes its own node.
     */
    const mountOrder = useMemo(
        () => retained.toSorted((left, right) => left.localeCompare(right)),
        [retained],
    );
    const terminalKey = useWorkbenchStore((state) =>
        (state.bootstrap?.sessionStates ?? [])
            .filter(({ sessionId }) => retainedIds.has(sessionId))
            .flatMap(({ paneLayout }) => listPaneTerminalIds(paneLayout))
            .join('\u{0}'),
    );
    useEffect(() => {
        retainTerminalProgress(new Set(terminalKey ? terminalKey.split('\u{0}') : []));
    }, [terminalKey]);
    /**
     * Every Chat Terminal of every Session, not only the mounted ones: a Chat's unsent images and "Edit from here" must
     * survive its Session leaving the keep-alive set, and are released only once the Chat itself is gone (closed,
     * deleted with its Session or Project, or switched to the Terminal surface). `undefined` until the first snapshot,
     * so nothing is released before the Workbench knows which Chats exist.
     */
    const chatTerminalKey = useWorkbenchStore((state) =>
        state.bootstrap?.terminals
            .filter((terminal) => isChatTerminal(terminal))
            .map(({ id }) => id)
            .join('\u{0}'),
    );
    useEffect(() => {
        if (chatTerminalKey === undefined) return;
        retainAgentChatComposerState(
            new Set(chatTerminalKey ? chatTerminalKey.split('\u{0}') : []),
        );
    }, [chatTerminalKey]);
    useEffect(() => {
        // One frame later, so the blur that hiding causes has started its transitions and the switch has painted.
        const frame = requestAnimationFrame(() => reconcileSessionAnimations(document));
        return () => cancelAnimationFrame(frame);
    }, [selectedSessionId]);
    return (
        <section className="workbench grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-background">
            {session ? (
                mountOrder.map((sessionId) => (
                    <div
                        key={sessionId}
                        // Every retained Workbench shares the one grid cell; only the visible one paints.
                        className="workbench-session col-start-1 row-start-1 min-h-0 min-w-0"
                        /**
                         * Deliberately not `data-session-id`: that attribute already identifies a PrimarySidebar
                         * Session row, and reusing it here made one id match two unrelated elements (a row to click and
                         * a whole Workbench subtree), so any lookup by Session id became ambiguous.
                         */
                        data-workbench-session-id={sessionId}
                        /**
                         * `hidden` marks the Session that is off screen, and `styles.css` turns it into
                         * `content-visibility: hidden` rather than `display: none`: the subtree skips style, layout,
                         * and paint all the same, but keeps its layout and every scroll offset, so coming back neither
                         * starts a Chat at its top nor scrolls it programmatically (which flashed the overlay
                         * scrollbar). `content-visibility: hidden` already keeps what `display: none` used to guarantee
                         * (no focus, no accessibility tree; `styles.css` also sends the box behind the visible Session
                         * so it takes no pointer), so `inert` is not set: toggling it restyled the whole subtree on
                         * every switch. Animations are paused by `reconcileSessionAnimations`.
                         */
                        hidden={sessionId !== selectedSessionId}
                    >
                        <PaneView
                            isVisible={sessionId === selectedSessionId}
                            sessionId={sessionId}
                        />
                    </div>
                ))
            ) : (
                <NoSessionSurface />
            )}
        </section>
    );
}
