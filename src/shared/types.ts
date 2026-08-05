/**
 * Domain types are inferred from the Zod schemas in `src/shared/ipc` so the IPC contract and the
 * TypeScript model can never drift. This module stays as the stable import path for consumers.
 */
export {
    MAX_CONFIGURABLE_FILE_BYTES,
    type AgentActivityState,
    type AgentProvider,
    type AgentSnapshot,
    type AppSettings,
    type BootstrapState,
    type EditorTabState,
    type FileChange,
    type FileDocument,
    type FileEntry,
    type GitDiffDocument,
    type GitFileStatus,
    type GitRepositorySummary,
    type GitSummary,
    type InspectorMode,
    type Keybinding,
    type KeybindingConflict,
    type PersistedWindowState,
    type ProcessState,
    type ProjectStatusCheck,
    type ProjectStatusDeployment,
    type ProjectStatusError,
    type ProjectStatusLinearIssue,
    type ProjectStatusRepository,
    type ProjectStatusState,
    type ProjectStatusSummary,
    type ProjectRecord,
    type SessionRecord,
    type SessionState,
    type TerminalKind,
    type TerminalRecord,
    type TerminalSnapshot,
    type ThemeTokens,
} from './ipc/domain';

export type {
    TerminalGroupNode,
    TerminalLayout,
    TerminalLayoutNode,
    TerminalSplitNode,
} from './ipc/layout';
