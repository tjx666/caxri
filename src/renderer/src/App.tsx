import {
    Circle,
    Code2,
    FileCode2,
    Plus,
    Search,
    Settings,
    SplitSquareVertical,
    TerminalSquare,
    X,
} from 'lucide-react';
import {
    lazy,
    Suspense,
    useCallback,
    useEffect,
    useEffectEvent,
    useMemo,
    useRef,
    useState,
} from 'react';

import type {
    BootstrapState,
    EditorTabState,
    FileDocument,
    InspectorMode,
    SessionState,
    TerminalKind,
    ThemeTokens,
} from '@shared/types';
import {
    editorModelPath,
    markTabsClean,
    replaceWithExternalDocument,
    setSessionDocument,
    type SessionDocuments,
    updateEditorTabState,
} from '@shared/editor-state';

import { keyboardEventShortcut, normalizeShortcut } from './commands';
import { CommandPalette } from './components/CommandPalette';
import { CreateSessionDialog } from './components/CreateSessionDialog';
import { Inspector } from './components/Inspector';
import { SettingsDialog } from './components/SettingsDialog';
import { StatusBar } from './components/StatusBar';
import { TerminalPane } from './components/TerminalPane';
import { Button } from './components/ui/button';

const CodeEditor = lazy(() => import('./components/CodeEditor'));
const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;
const inspectorCommands: Record<InspectorMode, string> = {
    files: 'inspector.showFiles',
    git: 'inspector.showGit',
    agent: 'inspector.showAgent',
};

function applyCssTheme(theme: ThemeTokens): void {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.colors))
        root.style.setProperty(`--${key}`, value);
}

export default function App() {
    const [bootstrap, setBootstrap] = useState<BootstrapState>();
    const [documentsBySession, setDocumentsBySession] = useState<SessionDocuments>({});
    const [activeWork, setActiveWork] = useState<string>();
    const [pendingRoot, setPendingRoot] = useState<string>();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [message, setMessage] = useState<string>();
    const [runtimeAttachEpoch, setRuntimeAttachEpoch] = useState(0);
    const messageTimerRef = useRef<number | undefined>(undefined);

    const showMessage = useCallback((value: string): void => {
        if (messageTimerRef.current) window.clearTimeout(messageTimerRef.current);
        setMessage(value);
        messageTimerRef.current = window.setTimeout(() => setMessage(undefined), 4_000);
    }, []);

    const refresh = useCallback(async (): Promise<BootstrapState | undefined> => {
        try {
            const state = await window.caxri.request<BootstrapState>('app.bootstrap');
            setBootstrap(state);
            return state;
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Unable to attach to the Runtime');
            return undefined;
        }
    }, [showMessage]);

    useEffect(() => {
        if (bootstrap?.theme) applyCssTheme(bootstrap.theme);
    }, [bootstrap?.theme]);

    const selectedSession = bootstrap?.sessions.find(
        (session) => session.id === bootstrap.selectedSessionId,
    );
    const documents = useMemo(
        () => (selectedSession ? (documentsBySession[selectedSession.id] ?? {}) : {}),
        [documentsBySession, selectedSession],
    );
    const documentsRef = useRef(documents);
    useEffect(() => {
        documentsRef.current = documents;
    }, [documents]);
    const sessionTerminals = useMemo(
        () =>
            bootstrap?.terminals.filter((terminal) => terminal.sessionId === selectedSession?.id) ??
            [],
        [bootstrap?.terminals, selectedSession?.id],
    );
    const sessionState = bootstrap?.sessionStates.find(
        (state) => state.sessionId === selectedSession?.id,
    );
    const sessionStateRef = useRef<SessionState | undefined>(undefined);
    useEffect(() => {
        sessionStateRef.current = sessionState;
    }, [sessionState]);
    const persistSessionState = useCallback(
        (next: SessionState, errorMessage = 'Session layout could not be saved'): void => {
            sessionStateRef.current = next;
            setBootstrap((current) =>
                current
                    ? {
                          ...current,
                          sessionStates: current.sessionStates.map((state) =>
                              state.sessionId === next.sessionId ? next : state,
                          ),
                      }
                    : current,
            );
            void window.caxri.request('session.updateState', next).catch((error: unknown) => {
                showMessage(error instanceof Error ? error.message : errorMessage);
            });
        },
        [showMessage],
    );
    const activeWorkExists = activeWork?.startsWith('terminal:')
        ? sessionTerminals.some((terminal) => `terminal:${terminal.id}` === activeWork)
        : activeWork?.startsWith('editor:')
          ? sessionState?.openTabs.some((tab) => `editor:${tab.path}` === activeWork)
          : false;
    const fallbackTerminalId = sessionState?.layout.splitTerminalIds[0] ?? sessionTerminals[0]?.id;
    const resolvedActiveWork = activeWorkExists
        ? activeWork
        : sessionState?.activeTab
          ? `editor:${sessionState.activeTab}`
          : fallbackTerminalId
            ? `terminal:${fallbackTerminalId}`
            : undefined;
    const restoredEditorPath = resolvedActiveWork?.startsWith('editor:')
        ? resolvedActiveWork.slice('editor:'.length)
        : undefined;

    useEffect(() => {
        if (!selectedSession || !restoredEditorPath || documentsRef.current[restoredEditorPath])
            return;
        let canceled = false;
        void window.caxri
            .request<FileDocument>('files.read', {
                sessionId: selectedSession.id,
                path: restoredEditorPath,
            })
            .then((document) => {
                if (!canceled)
                    setDocumentsBySession((current) =>
                        setSessionDocument(current, selectedSession.id, {
                            ...document,
                            dirty: false,
                        }),
                    );
            })
            .catch((error: unknown) =>
                showMessage(error instanceof Error ? error.message : 'Unable to restore file'),
            );
        return () => {
            canceled = true;
        };
    }, [restoredEditorPath, selectedSession, showMessage]);

    useEffect(() => {
        const unsubscribe = window.caxri.onEvent((event) => {
            if (event.event !== 'files.changed' || event.payload.sessionId !== selectedSession?.id)
                return;
            const changedPaths = event.payload.overflow
                ? (sessionStateRef.current?.openTabs.map((tab) => tab.path) ?? [])
                : event.payload.changes
                      .filter(
                          (change) => change.kind !== 'delete' && documentsRef.current[change.path],
                      )
                      .map((change) => change.path);
            const uniquePaths = [...new Set(changedPaths)];
            if (uniquePaths.length === 0) return;
            void Promise.allSettled(
                uniquePaths.map((path) =>
                    window.caxri.request<FileDocument>('files.read', {
                        sessionId: selectedSession.id,
                        path,
                    }),
                ),
            ).then((results) => {
                const reloaded = results.flatMap((result) =>
                    result.status === 'fulfilled' ? [result.value] : [],
                );
                if (reloaded.length === 0) return;
                /** External disk changes intentionally replace dirty buffers for agent-driven workflows. */
                setDocumentsBySession((current) =>
                    reloaded.reduce(
                        (next, document) =>
                            setSessionDocument(
                                next,
                                selectedSession.id,
                                replaceWithExternalDocument(document),
                            ),
                        current,
                    ),
                );
                const latestSessionState = sessionStateRef.current;
                if (latestSessionState?.sessionId === selectedSession.id) {
                    const nextState = markTabsClean(
                        latestSessionState,
                        reloaded.map((document) => document.path),
                    );
                    persistSessionState(nextState, 'External editor state could not be saved');
                }
                showMessage(
                    reloaded.length === 1
                        ? `${fileName(reloaded[0].path)} reloaded from disk; external changes take precedence.`
                        : `${reloaded.length} open files reloaded from disk; external changes take precedence.`,
                );
            });
        });
        return unsubscribe;
    }, [persistSessionState, selectedSession?.id, showMessage]);

    const updateOpenTab = (path: string, dirty: boolean): void => {
        const current = sessionStateRef.current;
        if (!current) return;
        const next = updateEditorTabState(current, path, dirty);
        if (next !== current) persistSessionState(next);
    };

    async function openFile(path: string): Promise<void> {
        if (!selectedSession) return;
        try {
            const document = await window.caxri.request<FileDocument>('files.read', {
                sessionId: selectedSession.id,
                path,
            });
            setDocumentsBySession((current) =>
                setSessionDocument(current, selectedSession.id, { ...document, dirty: false }),
            );
            setActiveWork(`editor:${path}`);
            updateOpenTab(path, false);
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Unable to open file');
        }
    }

    const closeEditor = (path: string): void => {
        const current = sessionStateRef.current;
        if (!current) return;
        const openTabs = current.openTabs.filter((tab) => tab.path !== path);
        const nextActive = current.activeTab === path ? openTabs.at(-1)?.path : current.activeTab;
        persistSessionState({ ...current, openTabs, activeTab: nextActive });
        setActiveWork(
            nextActive
                ? `editor:${nextActive}`
                : sessionTerminals[0]
                  ? `terminal:${sessionTerminals[0].id}`
                  : undefined,
        );
    };

    const saveActiveEditor = async (): Promise<void> => {
        if (!selectedSession || !resolvedActiveWork?.startsWith('editor:')) return;
        const path = resolvedActiveWork.slice('editor:'.length);
        const document = documents[path];
        if (!document) return;
        try {
            const saved = await window.caxri.request<FileDocument>('files.write', {
                sessionId: selectedSession.id,
                path,
                content: document.content,
            });
            setDocumentsBySession((current) =>
                setSessionDocument(current, selectedSession.id, { ...saved, dirty: false }),
            );
            updateOpenTab(path, false);
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Save failed');
        }
    };

    const chooseSessionDirectory = async (): Promise<void> => {
        try {
            const root = await window.caxri.request<string | null>('dialog.selectDirectory');
            if (!root) return;
            const defaultAgent = bootstrap?.settings['session.defaultAgent'];
            if (defaultAgent) await createSession(root, defaultAgent);
            else setPendingRoot(root);
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Directory selection failed');
        }
    };

    const createSession = async (root: string, defaultAgent: TerminalKind): Promise<void> => {
        try {
            await window.caxri.request('session.create', { rootPath: root, defaultAgent });
            setPendingRoot(undefined);
            await refresh();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Session creation failed');
        }
    };

    const selectSession = async (sessionId: string): Promise<void> => {
        try {
            await window.caxri.request('session.select', { sessionId });
            await refresh();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Session selection failed');
        }
    };

    const newTerminal = async (kind: TerminalKind = 'shell', split = false): Promise<void> => {
        if (!selectedSession) return;
        try {
            const terminal = await window.caxri.request<{ id: string }>('terminal.create', {
                sessionId: selectedSession.id,
                kind,
            });
            const currentState = sessionStateRef.current;
            if (currentState) {
                const splitTerminalIds = split
                    ? [...currentState.layout.splitTerminalIds.slice(-1), terminal.id]
                    : [terminal.id];
                persistSessionState({ ...currentState, layout: { splitTerminalIds } });
            }
            setActiveWork(`terminal:${terminal.id}`);
            await refresh();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Terminal creation failed');
        }
    };

    const activeTerminalId = resolvedActiveWork?.startsWith('terminal:')
        ? resolvedActiveWork.slice('terminal:'.length)
        : undefined;

    const setInspectorMode = (mode: InspectorMode): void => {
        const current = sessionStateRef.current;
        if (current) persistSessionState({ ...current, inspectorMode: mode });
    };

    const execute = (command: string): void => {
        const selectedIndex =
            bootstrap?.sessions.findIndex((session) => session.id === selectedSession?.id) ?? -1;
        switch (command) {
            case 'session.create':
                void chooseSessionDirectory();
                break;
            case 'session.delete':
                if (selectedSession)
                    void window.caxri
                        .request('session.delete', { sessionId: selectedSession.id })
                        .then(() => {
                            setDocumentsBySession((current) =>
                                Object.fromEntries(
                                    Object.entries(current).filter(
                                        ([sessionId]) => sessionId !== selectedSession.id,
                                    ),
                                ),
                            );
                            return refresh();
                        })
                        .catch((error: unknown) =>
                            showMessage(
                                error instanceof Error ? error.message : 'Session deletion failed',
                            ),
                        );
                break;
            case 'session.selectNext':
            case 'session.selectPrevious': {
                if (!bootstrap || selectedIndex < 0) break;
                const delta = command.endsWith('Next') ? 1 : -1;
                const next =
                    bootstrap.sessions[
                        (selectedIndex + delta + bootstrap.sessions.length) %
                            bootstrap.sessions.length
                    ];
                if (next) void selectSession(next.id);
                break;
            }
            case 'terminal.new':
                void newTerminal('shell');
                break;
            case 'terminal.restart':
                if (activeTerminalId)
                    void window.caxri
                        .request('terminal.restart', { terminalId: activeTerminalId })
                        .then(() => refresh())
                        .catch((error: unknown) =>
                            showMessage(
                                error instanceof Error ? error.message : 'Terminal restart failed',
                            ),
                        );
                break;
            case 'terminal.close':
                if (activeTerminalId)
                    void window.caxri
                        .request('terminal.close', { terminalId: activeTerminalId })
                        .then(() => refresh())
                        .catch((error: unknown) =>
                            showMessage(
                                error instanceof Error ? error.message : 'Terminal close failed',
                            ),
                        );
                break;
            case 'editor.save':
                void saveActiveEditor();
                break;
            case 'inspector.showFiles':
                setInspectorMode('files');
                break;
            case 'inspector.showGit':
                setInspectorMode('git');
                break;
            case 'inspector.showAgent':
                setInspectorMode('agent');
                break;
            case 'theme.openSettings':
                setSettingsOpen(true);
                break;
            case 'commandPalette.open':
                setPaletteOpen(true);
                break;
            case 'diagnostics.export':
                void window.caxri
                    .request<{ path: string } | null>('diagnostics.export')
                    .then((result) => {
                        if (result) showMessage(`Diagnostics exported to ${result.path}`);
                    })
                    .catch((error: unknown) =>
                        showMessage(
                            error instanceof Error ? error.message : 'Diagnostics export failed',
                        ),
                    );
                break;
        }
    };
    const onCommand = useEffectEvent(execute);

    useEffect(() => {
        void window.caxri
            .request<BootstrapState>('app.bootstrap')
            .then((state) => {
                setBootstrap(state);
                if (state.configurationErrors?.[0]) showMessage(state.configurationErrors[0]);
            })
            .catch((error: unknown) =>
                showMessage(
                    error instanceof Error ? error.message : 'Unable to attach to the Runtime',
                ),
            );
        const unsubscribe = window.caxri.onEvent((event) => {
            if (event.event === 'state.changed' || event.event === 'terminal.exit') void refresh();
            if (event.event === 'runtime.status') {
                setBootstrap((current) =>
                    current ? { ...current, runtime: event.payload } : current,
                );
                if (event.payload.status === 'ready') {
                    setRuntimeAttachEpoch((current) => current + 1);
                    void refresh();
                }
            }
            if (
                event.event === 'settings.changed' ||
                event.event === 'keybindings.changed' ||
                event.event === 'theme.changed'
            ) {
                if (event.payload.error) showMessage(event.payload.error);
                else void refresh();
            }
            if (event.event === 'command.execute') onCommand(event.payload.command);
        });
        return () => {
            unsubscribe();
            if (messageTimerRef.current) window.clearTimeout(messageTimerRef.current);
        };
    }, [refresh, showMessage]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (!bootstrap) return;
            const shortcut = keyboardEventShortcut(event);
            const binding = bootstrap.keybindings.find(
                (item) => normalizeShortcut(item.key) === shortcut,
            );
            if (!binding) return;
            event.preventDefault();
            onCommand(binding.command);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [bootstrap]);

    if (!bootstrap) {
        return (
            <main className="loading-screen">
                <Code2 size={25} />
                <span>{message ?? 'Attaching to Caxri Runtime…'}</span>
            </main>
        );
    }

    const splitTerminalIds = sessionState?.layout.splitTerminalIds.length
        ? sessionState.layout.splitTerminalIds
        : activeTerminalId
          ? [activeTerminalId]
          : [];
    const splitTerminals = splitTerminalIds
        .map((id) => sessionTerminals.find((terminal) => terminal.id === id))
        .filter(Boolean) as typeof sessionTerminals;
    const activeEditorPath = resolvedActiveWork?.startsWith('editor:')
        ? resolvedActiveWork.slice('editor:'.length)
        : undefined;
    const activeDocument = activeEditorPath ? documents[activeEditorPath] : undefined;

    return (
        <main className="app-shell">
            <aside className="session-sidebar">
                <div className="sidebar-title">
                    <span>
                        <TerminalSquare size={16} /> Caxri
                    </span>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Create Session"
                        onClick={() => execute('session.create')}
                    >
                        <Plus size={15} />
                    </Button>
                </div>
                <div className="session-list">
                    {bootstrap.sessions.map((session) => (
                        <button
                            key={session.id}
                            className={
                                session.id === selectedSession?.id
                                    ? 'session-card active'
                                    : 'session-card'
                            }
                            onClick={() => void selectSession(session.id)}
                        >
                            <span className={`activity activity-${session.lastActivityState}`}>
                                <Circle size={8} fill="currentColor" />
                            </span>
                            <span className="session-copy">
                                <strong>{session.displayTitle}</strong>
                                <small title={session.rootPath}>{session.rootPath}</small>
                                <em>
                                    {bootstrap.terminals.find(
                                        (terminal) =>
                                            terminal.id === session.defaultAgentTerminalId,
                                    )?.title ?? 'Shell'}
                                </em>
                            </span>
                        </button>
                    ))}
                    {bootstrap.sessions.length === 0 && (
                        <button className="first-session" onClick={() => execute('session.create')}>
                            <Plus size={16} /> Create your first Session
                        </button>
                    )}
                </div>
                <div className="sidebar-footer">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Settings"
                        onClick={() => execute('theme.openSettings')}
                    >
                        <Settings size={15} />
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Export Diagnostics"
                        onClick={() => execute('diagnostics.export')}
                    >
                        <Search size={15} />
                    </Button>
                </div>
            </aside>

            <section className="workbench">
                {selectedSession ? (
                    <>
                        <div className="work-tabs">
                            {sessionTerminals.map((terminal) => (
                                <button
                                    key={terminal.id}
                                    className={
                                        resolvedActiveWork === `terminal:${terminal.id}`
                                            ? 'active'
                                            : ''
                                    }
                                    onClick={() => {
                                        setActiveWork(`terminal:${terminal.id}`);
                                        if (sessionState)
                                            persistSessionState({
                                                ...sessionState,
                                                activeTab: undefined,
                                                layout: { splitTerminalIds: [terminal.id] },
                                            });
                                    }}
                                >
                                    <TerminalSquare size={13} />
                                    <span>{terminal.title}</span>
                                    <i className={`process-${terminal.lastProcessState}`} />
                                </button>
                            ))}
                            {sessionState?.openTabs.map((tab: EditorTabState) => (
                                <button
                                    key={tab.path}
                                    className={
                                        resolvedActiveWork === `editor:${tab.path}` ? 'active' : ''
                                    }
                                    onClick={() => {
                                        setActiveWork(`editor:${tab.path}`);
                                        if (!documents[tab.path]) void openFile(tab.path);
                                    }}
                                >
                                    <FileCode2 size={13} />
                                    <span>{fileName(tab.path)}</span>
                                    {documents[tab.path]?.dirty && <b>●</b>}
                                    <X
                                        size={12}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            closeEditor(tab.path);
                                        }}
                                    />
                                </button>
                            ))}
                            <div className="tab-actions">
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    title="New Terminal"
                                    onClick={() => execute('terminal.new')}
                                >
                                    <Plus size={14} />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    title="Split Terminal"
                                    onClick={() => void newTerminal('shell', true)}
                                >
                                    <SplitSquareVertical size={14} />
                                </Button>
                            </div>
                        </div>
                        <div className="work-surface">
                            {activeEditorPath ? (
                                activeDocument ? (
                                    <Suspense
                                        fallback={<div className="empty-work">Loading editor…</div>}
                                    >
                                        <CodeEditor
                                            path={editorModelPath(
                                                selectedSession.id,
                                                activeEditorPath,
                                            )}
                                            value={activeDocument.content}
                                            theme={bootstrap.theme}
                                            onChange={(content) => {
                                                setDocumentsBySession((current) =>
                                                    setSessionDocument(
                                                        current,
                                                        selectedSession.id,
                                                        {
                                                            ...current[selectedSession.id][
                                                                activeEditorPath
                                                            ],
                                                            content: content ?? '',
                                                            dirty: true,
                                                        },
                                                    ),
                                                );
                                                updateOpenTab(activeEditorPath, true);
                                            }}
                                        />
                                    </Suspense>
                                ) : (
                                    <div className="empty-work">Loading file…</div>
                                )
                            ) : splitTerminals.length > 0 ? (
                                <div
                                    className={`terminal-grid terminal-grid-${Math.min(splitTerminals.length, 2)}`}
                                >
                                    {splitTerminals.slice(0, 2).map((terminal) => (
                                        <TerminalPane
                                            key={terminal.id}
                                            attachEpoch={runtimeAttachEpoch}
                                            terminal={terminal}
                                            theme={bootstrap.theme}
                                            fontSize={bootstrap.settings['terminal.fontSize']}
                                            scrollback={bootstrap.settings['terminal.scrollback']}
                                            onRestart={(id) =>
                                                void window.caxri
                                                    .request('terminal.attach', { terminalId: id })
                                                    .then(() =>
                                                        window.caxri.request('terminal.restart', {
                                                            terminalId: id,
                                                        }),
                                                    )
                                                    .then(() => refresh())
                                                    .catch((error: unknown) =>
                                                        showMessage(
                                                            error instanceof Error
                                                                ? error.message
                                                                : 'Terminal restart failed',
                                                        ),
                                                    )
                                            }
                                            onError={showMessage}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <div className="empty-work">
                                    <TerminalSquare size={30} />
                                    <p>No Terminal in this Session.</p>
                                    <Button onClick={() => execute('terminal.new')}>
                                        New Terminal
                                    </Button>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="welcome">
                        <Code2 size={38} />
                        <h1>Session-first development.</h1>
                        <p>
                            Choose a directory, then keep its terminals, files, editor tabs, Git
                            context, and agent metadata together.
                        </p>
                        <Button onClick={() => execute('session.create')}>
                            <Plus size={15} /> Create Session
                        </Button>
                    </div>
                )}
            </section>

            <Inspector
                session={selectedSession}
                terminals={sessionTerminals}
                mode={sessionState?.inspectorMode ?? 'files'}
                onModeChange={(mode) => execute(inspectorCommands[mode])}
                onOpenFile={(path) => void openFile(path)}
                onError={showMessage}
            />

            <StatusBar
                rootPath={selectedSession?.rootPath}
                runningCount={
                    sessionTerminals.filter((terminal) => terminal.lastProcessState === 'running')
                        .length
                }
                runtimeStatus={bootstrap.runtime.status}
            />
            <CreateSessionDialog
                rootPath={pendingRoot}
                onOpenChange={(open) => !open && setPendingRoot(undefined)}
                onCreate={(kind) => pendingRoot && void createSession(pendingRoot, kind)}
            />
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                onApplied={() => void refresh()}
                onError={showMessage}
            />
            <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} execute={execute} />
            {message && (
                <div className="toast" role="status">
                    {message}
                </div>
            )}
        </main>
    );
}
