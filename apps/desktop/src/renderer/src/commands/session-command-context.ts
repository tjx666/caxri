import { focusNextAttentionSession } from '../features/agent-activity/agent-activity-commands';
import { takeBackFromBot } from '../features/caxri-bot/bot-handover-commands';
import { enterAirplaneMode } from '../features/session/airplane-mode/airplane-mode-commands';
import {
    detachSelectedSession,
    resumeSelectedSession,
} from '../features/session/session-agent-commands';
import {
    archiveSelectedSession,
    openArchivedSessions,
} from '../features/session/session-archive-commands';
import {
    canNavigateSessionHistory,
    deleteSelectedSession,
    navigateSessionHistory,
    openSelectedSessionPullRequest,
    selectAdjacentSession,
    switchMruSession,
} from '../features/session/session-commands';
import {
    compactWarmSessions,
    interruptAndCompactSessions,
} from '../features/session/session-compaction-commands';
import {
    beginSessionCreation,
    chooseProjectFolder,
} from '../features/session/session-creation-commands';
import { restoreQuitStoppedSessions } from '../features/session/session-quit-restore-commands';
import {
    renameSelectedSession,
    renameSelectedSessionWithAi,
} from '../features/session/session-rename-commands';
import { openPinnedSessionAtPosition } from '../features/session/session-window-commands';
import { getBootstrap, getSelectedSession, selectSelectedProject } from '../stores/selectors';
import type { CommandContext } from './registry';

/**
 * The `session` slice of the command context `execute.ts` composes.
 */
export const sessionCommandContext: CommandContext['session'] = {
    create: () => {
        const project = selectSelectedProject(getBootstrap());
        if (project) beginSessionCreation(project.id);
        else void chooseProjectFolder();
    },
    archiveSelected: archiveSelectedSession,
    compactWarm: compactWarmSessions,
    interruptAndCompact: interruptAndCompactSessions,
    enterAirplaneMode,
    restoreQuitStopped: restoreQuitStoppedSessions,
    canNavigateHistory: canNavigateSessionHistory,
    deleteSelected: deleteSelectedSession,
    detachSelected: detachSelectedSession,
    focusNextAttention: focusNextAttentionSession,
    navigateHistory: navigateSessionHistory,
    openArchived: openArchivedSessions,
    openPinned: openPinnedSessionAtPosition,
    openPullRequestSelected: openSelectedSessionPullRequest,
    renameSelected: renameSelectedSession,
    renameSelectedWithAi: renameSelectedSessionWithAi,
    resumeSelected: resumeSelectedSession,
    selectAdjacent: selectAdjacentSession,
    switchMru: switchMruSession,
    takeBackSelectedFromBot: () => {
        const session = getSelectedSession();
        if (session) takeBackFromBot(session.id);
    },
};
