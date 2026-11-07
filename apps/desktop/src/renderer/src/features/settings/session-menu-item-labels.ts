import type { SessionMenuItemId } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

/**
 * The name each Session menu slot goes by in the Settings editor. A slot that swaps between two actions (Pin and Unpin)
 * names both, and one whose menu label carries a value (the pull request number) gets a generic name; every other slot
 * reuses the menu's own label so the two always read the same.
 */
export const sessionMenuItemLabels: Record<SessionMenuItemId, TranslationKey> = {
    markAsDone: 'primarySidebar.sessionMenu.markAsDone',
    archive: 'primarySidebar.sessionMenu.archive',
    pin: 'settings.sessionMenuForm.item.pin',
    detachAgent: 'settings.sessionMenuForm.item.detachAgent',
    switchSurface: 'settings.sessionMenuForm.item.switchSurface',
    restartAgent: 'terminal.recovery.restartAgent',
    reopenConversation: 'primarySidebar.sessionMenu.reopenConversation',
    turnOffAlwaysAllow: 'primarySidebar.sessionMenu.turnOffAlwaysAllow',
    forkSession: 'primarySidebar.sessionMenu.forkSession',
    continueInAgent: 'agentChat.continueMenu.label',
    handOverToBot: 'settings.sessionMenuForm.item.handOverToBot',
    openInNewWindow: 'primarySidebar.sessionMenu.openInNewWindow',
    openProjectInEditor: 'primarySidebar.sessionMenu.openProjectInEditor',
    goToCreatingSession: 'primarySidebar.sessionMenu.goToCreatingSession',
    openPullRequest: 'settings.sessionMenuForm.item.openPullRequest',
    copy: 'primarySidebar.sessionMenu.copy',
    rename: 'common.rename',
    renameWithAi: 'primarySidebar.sessionMenu.renameWithAi',
    deleteSession: 'primarySidebar.sessionMenu.deleteSession',
};
