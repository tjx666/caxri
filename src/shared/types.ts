export const MAX_CONFIGURABLE_FILE_BYTES = 16 * 1024 * 1024;

export type AgentProvider = 'claude' | 'codex';
export type AgentActivityState =
    'running' | 'waiting' | 'completed' | 'failed' | 'idle' | 'unknown';
export type TerminalKind = AgentProvider | 'shell';
export type ProcessState = 'starting' | 'running' | 'stopped' | 'dead' | 'failed';
export type InspectorMode = 'files' | 'git' | 'agent';

export interface AgentSnapshot {
    provider: AgentProvider;
    sessionId?: string;
    title?: string;
    status: AgentActivityState;
    usage?: Array<{ label: string; value: string }>;
    observedAt: number;
    available: boolean;
    executable?: string;
    version?: string;
}

export interface ProjectRecord {
    id: string;
    rootPath: string;
    displayTitle: string;
    createdAt: number;
    lastOpenedAt: number;
}

export interface SessionRecord {
    id: string;
    projectId: string;
    /** Project-owned root projected onto the Session read model for path-scoped services. */
    rootPath: string;
    createdAt: number;
    lastOpenedAt: number;
    defaultAgentTerminalId?: string;
    lastActivityState: AgentActivityState;
    layoutVersion: number;
    displayTitle: string;
}

export interface TerminalRecord {
    id: string;
    sessionId: string;
    kind: TerminalKind;
    provider?: AgentProvider;
    cwd: string;
    title: string;
    icon: string;
    orderIndex: number;
    layoutNodeId: string;
    agentSessionId?: string;
    lastProcessState: ProcessState;
    createdAt: number;
    updatedAt: number;
}

export interface TerminalSnapshot {
    terminalId: string;
    encodingVersion: number;
    lineCount: number;
    byteCount: number;
    payload: string;
    updatedAt: number;
}

export interface EditorTabState {
    path: string;
    dirty: boolean;
}

export interface SessionState {
    sessionId: string;
    openTabs: EditorTabState[];
    activeTab?: string;
    inspectorMode: InspectorMode;
    layout: {
        splitTerminalIds: string[];
    };
}

export interface AppSettings {
    'session.defaultAgent': TerminalKind | null;
    'terminal.fontSize': number;
    'terminal.scrollback': number;
    'files.maxFileBytes': number;
}

export interface PersistedWindowState {
    bounds: {
        x?: number;
        y?: number;
        width: number;
        height: number;
    };
    isMaximized: boolean;
    isFullScreen: boolean;
}

export interface Keybinding {
    key: string;
    command: string;
}

export interface KeybindingConflict {
    key: string;
    commands: string[];
}

export interface ThemeTokens {
    id: string;
    name: string;
    source: 'builtin' | 'custom' | 'vscode' | 'iterm2' | 'warp';
    colors: {
        background: string;
        surface: string;
        elevated: string;
        foreground: string;
        muted: string;
        border: string;
        selection: string;
        accent: string;
        success: string;
        warning: string;
        danger: string;
    };
    terminal: {
        background: string;
        foreground: string;
        cursor: string;
        selectionBackground: string;
        black: string;
        red: string;
        green: string;
        yellow: string;
        blue: string;
        magenta: string;
        cyan: string;
        white: string;
        brightBlack: string;
        brightRed: string;
        brightGreen: string;
        brightYellow: string;
        brightBlue: string;
        brightMagenta: string;
        brightCyan: string;
        brightWhite: string;
    };
    editor: {
        background: string;
        foreground: string;
        lineHighlight: string;
        selection: string;
        comment: string;
        keyword: string;
        string: string;
        number: string;
    };
    warnings: string[];
}

export interface FileEntry {
    name: string;
    path: string;
    kind: 'file' | 'directory' | 'symlink';
    size?: number;
}

export interface FileChange {
    path: string;
    kind: 'create' | 'update' | 'delete';
}

export interface FileDocument {
    path: string;
    content: string;
    mtimeMs: number;
    size: number;
}

export interface GitFileStatus {
    path: string;
    index: string;
    workingTree: string;
    kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
}

export interface GitSummary {
    isRepository: boolean;
    branch?: string;
    head?: string;
    files: GitFileStatus[];
    error?: string;
}

export interface BootstrapState {
    projects: ProjectRecord[];
    sessions: SessionRecord[];
    terminals: TerminalRecord[];
    selectedProjectId?: string;
    selectedSessionId?: string;
    sessionStates: SessionState[];
    settings: AppSettings;
    keybindings: Keybinding[];
    keybindingConflicts: KeybindingConflict[];
    configurationErrors?: string[];
    theme: ThemeTokens;
    runtime: {
        status: 'starting' | 'ready' | 'restarting' | 'failed';
        restartCount: number;
    };
}
