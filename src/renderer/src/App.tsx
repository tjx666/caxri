import { Code2, Plus, SplitSquareVertical, TerminalSquare } from 'lucide-react';
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
    InspectorMode,
    SessionState,
    TerminalKind,
} from '@shared/types';
import { addTerminal, splitTerminal } from '@shared/terminal-layout';
import {
    editorModelPath,
    setSessionDocument,
    type SessionDocuments,
    updateEditorTabState,
} from '@shared/editor-state';
import {
    activateWorkState,
    resolveActiveWork,
    workItemsEqual,
    type WorkItem,
} from '@shared/work-item';

import { keyboardEventShortcut, normalizeShortcut } from './commands';
import { CommandPalette } from './components/CommandPalette';
import { CreateSessionDialog } from './components/CreateSessionDialog';
import { Inspector } from './components/Inspector';
import { ProjectSidebar } from './components/ProjectSidebar';
import { SettingsDialog } from './components/SettingsDialog';
import { StatusBar } from './components/StatusBar';
import { TERMINAL_DRAG_TYPE, TerminalLayoutView } from './components/TerminalLayoutView';
import { WorkTab } from './components/WorkTab';
import { Button } from './components/ui/button';
import { useExternalDocumentSync } from './hooks/useExternalDocumentSync';
import { caxri } from './lib/caxri';
import { clearTerminalView } from './lib/terminal-view-commands';
import { applyCssTheme } from './lib/theme-css';

const CodeEditor = lazy(() => import('./components/CodeEditor'));
const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;
const inspectorCommands: Record<InspectorMode, string> = {
    files: 'inspector.showFiles',
    git: 'inspector.showGit',
    info: 'inspector.showInfo',
};

export default function App() {
    const [bootstrap, setBootstrap] = useState<BootstrapState>();
    const [documentsBySession, setDocumentsBySession] = useState<SessionDocuments>({});
    const [activeWork, setActiveWork] = useState<WorkItem>();
    const [pendingRoot, setPendingRoot] = useState<string>();
    const [pendingProjectId, setPendingProjectId] = useState<string>();
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
            const state = await caxri.request('app.bootstrap');
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
    const selectedProject = bootstrap?.projects.find(
        (project) => project.id === (selectedSession?.projectId ?? bootstrap.selectedProjectId),
    );
    const documents = useMemo(
        () => (selectedSession ? (documentsBySession[selectedSession.id] ?? {}) : {}),
        [documentsBySession, selectedSession],
    );
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
            void caxri.request('session.updateState', next).catch((error: unknown) => {
                showMessage(error instanceof Error ? error.message : errorMessage);
            });
        },
        [showMessage],
    );

    /**
     * The single write path for "what is focused in the center pane": updates local `activeWork`
     * plus persisted `sessionState.activeTab` (and, for a Terminal, the layout's active group) in one
     * update. `resolveActiveWork` is the corresponding single read path.
     */
    const activateWork = useCallback(
        (item: WorkItem): void => {
            setActiveWork(item);
            const current = sessionStateRef.current;
            if (!current) return;
            const next = activateWorkState(current, item);
            if (next !== current) persistSessionState(next);
        },
        [persistSessionState],
    );

    const resolvedActiveWork = resolveActiveWork({ activeWork, sessionTerminals, sessionState });
    const restoredEditorPath =
        resolvedActiveWork?.kind === 'editor' ? resolvedActiveWork.path : undefined;

    useEffect(() => {
        if (!selectedSession || !restoredEditorPath || documents[restoredEditorPath]) return;
        let canceled = false;
        void caxri
            .request('files.read', {
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
    }, [documents, restoredEditorPath, selectedSession, showMessage]);

    useExternalDocumentSync({
        documents,
        documentsBySession,
        persistSessionState,
        selectedSessionId: selectedSession?.id,
        sessionState,
        setDocumentsBySession,
        showMessage,
    });

    const updateOpenTab = (path: string, dirty: boolean): void => {
        const current = sessionStateRef.current;
        if (!current) return;
        const next = updateEditorTabState(current, path, dirty);
        if (next !== current) persistSessionState(next);
    };

    async function openFile(path: string): Promise<void> {
        if (!selectedSession) return;
        try {
            const document = await caxri.request('files.read', {
                sessionId: selectedSession.id,
                path,
            });
            setDocumentsBySession((current) =>
                setSessionDocument(current, selectedSession.id, { ...document, dirty: false }),
            );
            updateOpenTab(path, false);
            activateWork({ kind: 'editor', path });
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Unable to open file');
        }
    }

    const closeEditor = (path: string): void => {
        const current = sessionStateRef.current;
        if (!current) return;
        const openTabs = current.openTabs.filter((tab) => tab.path !== path);
        const wasActive = current.activeTab?.kind === 'editor' && current.activeTab.path === path;
        if (!wasActive) {
            persistSessionState({ ...current, openTabs });
            return;
        }
        const fallbackPath = openTabs.at(-1)?.path;
        const nextItem: WorkItem | undefined = fallbackPath
            ? { kind: 'editor', path: fallbackPath }
            : sessionTerminals[0]
              ? { kind: 'terminal', terminalId: sessionTerminals[0].id }
              : undefined;
        setActiveWork(nextItem);
        /**
         * Reuses `activateWorkState` rather than calling `activateWork` so the openTabs removal and
         * the fallback selection persist atomically instead of as two IPC round trips.
         */
        persistSessionState(
            nextItem
                ? activateWorkState({ ...current, openTabs }, nextItem)
                : { ...current, openTabs, activeTab: undefined },
        );
    };

    const saveActiveEditor = async (): Promise<void> => {
        if (!selectedSession || resolvedActiveWork?.kind !== 'editor') return;
        const path = resolvedActiveWork.path;
        const document = documents[path];
        if (!document) return;
        try {
            const saved = await caxri.request('files.write', {
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

    const chooseProjectDirectory = async (): Promise<void> => {
        try {
            const root = await caxri.request('dialog.selectDirectory');
            if (!root) return;
            const defaultAgent = bootstrap?.settings['session.defaultAgent'];
            if (defaultAgent) await createProjectSession(root, defaultAgent);
            else setPendingRoot(root);
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Directory selection failed');
        }
    };

    const createSession = async (projectId: string, defaultAgent: TerminalKind): Promise<void> => {
        try {
            await caxri.request('session.create', { projectId, defaultAgent });
            setPendingRoot(undefined);
            setPendingProjectId(undefined);
            await refresh();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Session creation failed');
        }
    };

    const createProjectSession = async (
        rootPath: string,
        defaultAgent: TerminalKind,
    ): Promise<void> => {
        try {
            const project = await caxri.request('project.create', {
                rootPath,
            });
            setPendingRoot(undefined);
            setPendingProjectId(project.id);
            await createSession(project.id, defaultAgent);
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Project creation failed');
        }
    };

    const beginSessionCreation = (projectId: string): void => {
        const defaultAgent = bootstrap?.settings['session.defaultAgent'];
        if (defaultAgent) void createSession(projectId, defaultAgent);
        else setPendingProjectId(projectId);
    };

    const selectSession = async (sessionId: string): Promise<void> => {
        try {
            await caxri.request('session.select', { sessionId });
            await refresh();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Session selection failed');
        }
    };

    const selectProject = (projectId: string): void => {
        const session = bootstrap?.sessions.find((item) => item.projectId === projectId);
        if (session) void selectSession(session.id);
        else beginSessionCreation(projectId);
    };

    const newTerminal = async (kind: TerminalKind = 'shell', split = false): Promise<void> => {
        if (!selectedSession) return;
        try {
            const terminal = await caxri.request('terminal.create', {
                sessionId: selectedSession.id,
                kind,
            });
            const currentState = sessionStateRef.current;
            const item: WorkItem = { kind: 'terminal', terminalId: terminal.id };
            setActiveWork(item);
            if (currentState) {
                const layout =
                    split && currentState.layout.activeGroupId
                        ? splitTerminal(
                              currentState.layout,
                              terminal.id,
                              currentState.layout.activeGroupId,
                              'horizontal',
                          )
                        : addTerminal(currentState.layout, terminal.id);
                persistSessionState({ ...currentState, activeTab: item, layout });
            }
            await refresh();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Terminal creation failed');
        }
    };

    const activeTerminalId =
        resolvedActiveWork?.kind === 'terminal' ? resolvedActiveWork.terminalId : undefined;

    const closeTerminal = (terminalId: string): void => {
        void caxri
            .request('terminal.close', { terminalId })
            .then(() => refresh())
            .catch((error: unknown) =>
                showMessage(error instanceof Error ? error.message : 'Terminal close failed'),
            );
    };

    const restartTerminal = (terminalId: string): void => {
        void caxri
            .request('terminal.attach', { terminalId })
            .then(() => caxri.request('terminal.restart', { terminalId }))
            .then(() => refresh())
            .catch((error: unknown) =>
                showMessage(error instanceof Error ? error.message : 'Terminal restart failed'),
            );
    };

    const setInspectorMode = (mode: InspectorMode): void => {
        const current = sessionStateRef.current;
        if (current) persistSessionState({ ...current, inspectorMode: mode });
    };

    const execute = (command: string): void => {
        const selectedIndex =
            bootstrap?.sessions.findIndex((session) => session.id === selectedSession?.id) ?? -1;
        switch (command) {
            case 'project.create':
                void chooseProjectDirectory();
                break;
            case 'project.delete':
                if (selectedProject)
                    void caxri
                        .request('project.delete', { projectId: selectedProject.id })
                        .then((result) => {
                            if ('canceled' in result) return;
                            const removedSessionIds = new Set(
                                bootstrap?.sessions
                                    .filter((session) => session.projectId === selectedProject.id)
                                    .map((session) => session.id) ?? [],
                            );
                            setDocumentsBySession((current) =>
                                Object.fromEntries(
                                    Object.entries(current).filter(
                                        ([sessionId]) => !removedSessionIds.has(sessionId),
                                    ),
                                ),
                            );
                            return refresh();
                        })
                        .catch((error: unknown) =>
                            showMessage(
                                error instanceof Error ? error.message : 'Project removal failed',
                            ),
                        );
                break;
            case 'session.create':
                if (selectedProject) beginSessionCreation(selectedProject.id);
                else void chooseProjectDirectory();
                break;
            case 'session.delete':
                if (selectedSession)
                    void caxri
                        .request('session.delete', { sessionId: selectedSession.id })
                        .then((result) => {
                            if ('canceled' in result) return;
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
            case 'terminal.clear':
                if (activeTerminalId) clearTerminalView(activeTerminalId);
                break;
            case 'terminal.restart':
                if (activeTerminalId)
                    void caxri
                        .request('terminal.restart', { terminalId: activeTerminalId })
                        .then(() => refresh())
                        .catch((error: unknown) =>
                            showMessage(
                                error instanceof Error ? error.message : 'Terminal restart failed',
                            ),
                        );
                break;
            case 'terminal.close':
                if (activeTerminalId) closeTerminal(activeTerminalId);
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
            case 'inspector.showInfo':
                setInspectorMode('info');
                break;
            case 'theme.openSettings':
                setSettingsOpen(true);
                break;
            case 'commandPalette.open':
                setPaletteOpen(true);
                break;
            case 'diagnostics.export':
                void caxri
                    .request('diagnostics.export')
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
    const onCommand = useEffectEvent((command: string): void => {
        /** App-wide shortcuts must not mutate workbench state behind a modal dialog. */
        if (settingsOpen || paletteOpen || pendingRoot || pendingProjectId) return;
        execute(command);
    });

    useEffect(() => {
        void caxri
            .request('app.bootstrap')
            .then((state) => {
                setBootstrap(state);
                if (state.configurationErrors?.[0]) showMessage(state.configurationErrors[0]);
            })
            .catch((error: unknown) =>
                showMessage(
                    error instanceof Error ? error.message : 'Unable to attach to the Runtime',
                ),
            );
        const unsubscribe = caxri.onEvent((event) => {
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

    const activeEditorPath =
        resolvedActiveWork?.kind === 'editor' ? resolvedActiveWork.path : undefined;
    const activeDocument = activeEditorPath ? documents[activeEditorPath] : undefined;

    return (
        <main className="app-shell">
            <ProjectSidebar
                projects={bootstrap.projects}
                sessions={bootstrap.sessions}
                terminals={bootstrap.terminals}
                selectedProjectId={selectedProject?.id}
                selectedSessionId={selectedSession?.id}
                onAddProject={() => execute('project.create')}
                onCreateSession={beginSessionCreation}
                onSelectProject={selectProject}
                onSelectSession={(sessionId) => void selectSession(sessionId)}
                onOpenSettings={() => execute('theme.openSettings')}
                onSearch={() => execute('commandPalette.open')}
            />

            <section className="workbench">
                {selectedSession ? (
                    <>
                        <div className="work-tabs" role="tablist" aria-label="Open work">
                            {sessionTerminals.map((terminal) => (
                                <WorkTab
                                    key={terminal.id}
                                    active={workItemsEqual(resolvedActiveWork, {
                                        kind: 'terminal',
                                        terminalId: terminal.id,
                                    })}
                                    closeLabel="Close Terminal"
                                    icon={terminal.kind}
                                    label={terminal.title}
                                    status={terminal.lastProcessState}
                                    terminalId={terminal.id}
                                    onClose={() => closeTerminal(terminal.id)}
                                    onDragStart={(event) => {
                                        event.dataTransfer.effectAllowed = 'move';
                                        event.dataTransfer.setData(TERMINAL_DRAG_TYPE, terminal.id);
                                        event.dataTransfer.setData('text/plain', terminal.id);
                                    }}
                                    onSelect={() =>
                                        activateWork({ kind: 'terminal', terminalId: terminal.id })
                                    }
                                />
                            ))}
                            {sessionState?.openTabs.map((tab: EditorTabState) => (
                                <WorkTab
                                    key={tab.path}
                                    active={workItemsEqual(resolvedActiveWork, {
                                        kind: 'editor',
                                        path: tab.path,
                                    })}
                                    closeLabel="Close Editor"
                                    dirty={documents[tab.path]?.dirty}
                                    icon="file"
                                    label={fileName(tab.path)}
                                    onClose={() => closeEditor(tab.path)}
                                    onSelect={() => {
                                        if (documents[tab.path])
                                            activateWork({ kind: 'editor', path: tab.path });
                                        else void openFile(tab.path);
                                    }}
                                />
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
                            ) : sessionState?.layout.root ? (
                                <TerminalLayoutView
                                    attachEpoch={runtimeAttachEpoch}
                                    terminals={sessionTerminals}
                                    layout={sessionState.layout}
                                    theme={bootstrap.theme}
                                    fontSize={bootstrap.settings['terminal.fontSize']}
                                    scrollback={bootstrap.settings['terminal.scrollback']}
                                    onActivate={(terminalId) =>
                                        activateWork({ kind: 'terminal', terminalId })
                                    }
                                    onLayoutChange={(layout) => {
                                        const current = sessionStateRef.current;
                                        if (current)
                                            persistSessionState({
                                                ...current,
                                                activeTab: undefined,
                                                layout,
                                            });
                                    }}
                                    onRestart={restartTerminal}
                                    onError={showMessage}
                                />
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
                        <h1>Project-first development.</h1>
                        <p>
                            Add a local folder as a Project, then keep every Agent and Shell Session
                            together beneath it.
                        </p>
                        <Button onClick={() => execute('project.create')}>
                            <Plus size={15} /> Add Project
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
                open={Boolean(pendingRoot || pendingProjectId)}
                contextLabel={
                    pendingRoot ??
                    bootstrap.projects.find((project) => project.id === pendingProjectId)
                        ?.displayTitle
                }
                onCancel={() => {
                    if (pendingRoot)
                        void caxri.request('project.cancelCreate', {
                            rootPath: pendingRoot,
                        });
                    setPendingRoot(undefined);
                    setPendingProjectId(undefined);
                }}
                onCreate={(kind) => {
                    if (pendingRoot) void createProjectSession(pendingRoot, kind);
                    else if (pendingProjectId) void createSession(pendingProjectId, kind);
                }}
            />
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                onApplied={() => void refresh()}
                onError={showMessage}
            />
            <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                execute={execute}
                projects={bootstrap.projects}
                sessions={bootstrap.sessions}
                selectProject={selectProject}
                selectSession={(sessionId) => void selectSession(sessionId)}
            />
            {message && (
                <div className="toast" role="status">
                    {message}
                </div>
            )}
        </main>
    );
}
