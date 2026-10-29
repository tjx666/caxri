import type { TranslatedNamespace } from '@caxri/protocol';
import { agentChatLabelsZhCN } from '@caxri/protocol';
import { commands } from '@desktop-shared/i18n/zh-cn/commands';

import type { enResources } from '../en';
import { agentActions } from './agent-actions';
import { agentActivity } from './agent-activity';
import { agentChat } from './agent-chat';
import { agentInbox } from './agent-inbox';
import { agentSecrets } from './agent-secrets';
import { agentStatus } from './agent-status';
import { benchmark } from './benchmark';
import { bugReport } from './bug-report';
import { caxriBot } from './caxri-bot';
import { common } from './common';
import { confirmations } from './confirmations';
import { core } from './core';
import { editor } from './editor';
import { gpu } from './gpu';
import { keyboardShortcuts } from './keyboard-shortcuts';
import { palette } from './palette';
import { panel } from './panel';
import { pathBrowser } from './path-browser';
import { performanceMonitor } from './performance-monitor';
import { preview } from './preview';
import { primarySidebar } from './primary-sidebar';
import { processExplorer } from './process-explorer';
import { projectSearch } from './project-search';
import { rendererPerformance } from './renderer-performance';
import { screencast } from './screencast';
import { secondarySidebar } from './secondary-sidebar';
import { session } from './session';
import { settings } from './settings';
import { share } from './share';
import { shellCommand } from './shell-command';
import { sshHost } from './ssh-host';
import { statusBar } from './status-bar';
import { tabs } from './tabs';
import { terminal } from './terminal';
import { toasts } from './toasts';
import { updates } from './updates';
import { usage } from './usage';
import { viewContainers } from './view-containers';
import { windowZoom } from './window-zoom';
import { workbench } from './workbench';

/**
 * Simplified Chinese strings. Each namespace module is typed against its English source, and this aggregate is typed
 * against the English aggregate, so a namespace registered in one locale but not the other fails type checking.
 */
export const zhCNResources: TranslatedNamespace<typeof enResources> = {
    ...agentActions,
    ...agentActivity,
    ...agentChat,
    ...agentChatLabelsZhCN,
    ...caxriBot,
    ...agentInbox,
    ...agentSecrets,
    ...agentStatus,
    ...benchmark,
    ...bugReport,
    ...commands,
    ...common,
    ...confirmations,
    ...core,
    ...editor,
    ...gpu,
    ...keyboardShortcuts,
    ...palette,
    ...panel,
    ...pathBrowser,
    ...preview,
    ...primarySidebar,
    ...performanceMonitor,
    ...processExplorer,
    ...projectSearch,
    ...rendererPerformance,
    ...screencast,
    ...secondarySidebar,
    ...session,
    ...settings,
    ...share,
    ...shellCommand,
    ...sshHost,
    ...statusBar,
    ...tabs,
    ...terminal,
    ...toasts,
    ...updates,
    ...usage,
    ...viewContainers,
    ...windowZoom,
    ...workbench,
};
