import { useEffect, useMemo } from 'react';

import { listPaneTerminalIds } from '@caxri/protocol';
import { Code2, Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useSelectedSession } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { chooseProjectFolder } from '../session/session-commands';
import { retainTerminalProgress } from '../terminal/terminal-progress';
import { PaneView } from './pane-view';
import {
    pruneKeepAliveSessions,
    retainKeepAliveSession,
    SESSION_KEEP_ALIVE_LIMIT,
    useSessionKeepAliveStore,
} from './session-keep-alive';

function Welcome() {
    return (
        <div className="welcome mx-auto flex h-full max-w-[540px] flex-col items-center justify-center gap-3 p-6 text-center text-muted">
            <Code2 size={38} />
            <h1 className="mx-0 mt-1 mb-0 text-[15px] text-foreground">
                Project-first development.
            </h1>
            <p className="m-0 leading-relaxed">
                Add a folder as a Project, then keep every Agent and Shell Session together beneath
                it.
            </p>
            <Button
                onClick={() => {
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, chooseProjectFolder() reports its own errors via tryCommand
                    void chooseProjectFolder();
                }}
            >
                <Plus size={15} /> Add Project
            </Button>
        </div>
    );
}

/**
 * The Workbench is now nothing but the pane tree: there is no Workbench-level tab strip and no Terminal-versus-Editor
 * surface switch, because every tab lives in the bar of the pane that holds it.
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
     * which the newly selected Session is not retained yet — every Workbench hidden, the user looking at nothing — and
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
    const terminalKey = useWorkbenchStore((state) =>
        (state.bootstrap?.sessionStates ?? [])
            .filter(({ sessionId }) => retained.includes(sessionId))
            .flatMap(({ paneLayout }) => listPaneTerminalIds(paneLayout))
            .join('\u{0}'),
    );
    useEffect(() => {
        retainTerminalProgress(new Set(terminalKey ? terminalKey.split('\u{0}') : []));
    }, [terminalKey]);
    return (
        <section className="workbench flex min-h-0 min-w-0 flex-col bg-background">
            {session ? (
                retained.map((sessionId) => (
                    <div
                        key={sessionId}
                        className="workbench-session h-full min-h-0 w-full min-w-0"
                        data-session-id={sessionId}
                        // `hidden` rather than a class, matching `ChromeTabPanel`: it takes the subtree out of the
                        // accessibility tree and out of `Tab` order while leaving the DOM — and therefore xterm's
                        // buffer and the Editor's models — intact.
                        hidden={sessionId !== selectedSessionId}
                    >
                        <PaneView
                            isVisible={sessionId === selectedSessionId}
                            sessionId={sessionId}
                        />
                    </div>
                ))
            ) : (
                <Welcome />
            )}
        </section>
    );
}
