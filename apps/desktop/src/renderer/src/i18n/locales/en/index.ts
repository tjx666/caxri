import { agentChatLabelsEn } from '@caxri/protocol';
import { commands } from '@desktop-shared/i18n/en/commands';

import { agentActions } from './agent-actions';
import { agentActivity } from './agent-activity';
import { agentChat } from './agent-chat';
import { agentCommander } from './agent-commander';
import { agentInbox } from './agent-inbox';
import { agentStatus } from './agent-status';
import { benchmark } from './benchmark';
import { bugReport } from './bug-report';
import { common } from './common';
import { confirmations } from './confirmations';
import { core } from './core';
import { editor } from './editor';
import { gpu } from './gpu';
import { keyboardShortcuts } from './keyboard-shortcuts';
import { palette } from './palette';
import { panel } from './panel';
import { pathBrowser } from './path-browser';
import { preview } from './preview';
import { primarySidebar } from './primary-sidebar';
import { processExplorer } from './process-explorer';
import { projectSearch } from './project-search';
import { rendererPerformance } from './renderer-performance';
import { screencast } from './screencast';
import { secondarySidebar } from './secondary-sidebar';
import { session } from './session';
import { settings } from './settings';
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
 * English source strings, one module per namespace. English is the source language: its keys define `TranslationKey`,
 * and every other locale must provide exactly the same keys.
 */
export const enResources = {
    ...agentActions,
    ...agentActivity,
    ...agentChat,
    ...agentChatLabelsEn,
    ...agentCommander,
    ...agentInbox,
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
    ...processExplorer,
    ...projectSearch,
    ...rendererPerformance,
    ...screencast,
    ...secondarySidebar,
    ...session,
    ...settings,
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
