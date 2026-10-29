import { z } from 'zod';

import { agentSecretLogEvents } from '../agent/secret/secret-log-events.js';
import { claudeWindowLogEvents } from './claude-window/log-events.js';
import {
    agentChatLogEvents,
    agentDelegationLogEvents,
    agentDispatchLogEvents,
    agentEndpointLogEvents,
    agentHooksLogEvents,
    agentLogEvents,
    agentMessageLogEvents,
    agentNotificationsLogEvents,
} from './logging/logging-agent.js';
import { agentChatSubagentLogEvents } from './logging/logging-agent-chat-subagents.js';
import { benchmarkLogEvents, benchmarkWindowLogEvents } from './logging/logging-benchmark.js';
import { caxriBotLogEvents } from './logging/logging-caxri-bot.js';
import { loginShellLogEvents } from './logging/logging-login-shell.js';
import { mobileGatewayLogEvents } from './logging/logging-mobile-gateway.js';
import { pathBrowserLogEvents } from './logging/logging-path-browser.js';
import {
    appLogEvents,
    configLogEvents,
    databaseLogEvents,
    desktopLogEvents,
    diagnosticsLogEvents,
    e2eLogEvents,
    extensionHostLogEvents,
    gpuLogEvents,
    ipcLogEvents,
    logLogEvents,
    performanceMonitorLogEvents,
    processExplorerLogEvents,
    processLogEvents,
    rendererLogEvents,
    serverConnectionLogEvents,
    serverCoreLogEvents,
    updatesLogEvents,
} from './logging/logging-runtime.js';
import {
    sessionAirplaneModeLogEvents,
    sessionCompactionLogEvents,
    sessionContextLogEvents,
    sessionPullRequestsLogEvents,
    sessionRenameLogEvents,
    sessionSearchLogEvents,
} from './logging/logging-session.js';
import { sshHostLogEvents } from './logging/logging-ssh-host.js';
import {
    ptyLogEvents,
    terminalHostLogEvents,
    terminalLogEvents,
} from './logging/logging-terminal.js';
import { usageLogEvents } from './logging/logging-usage.js';
import { windowLogEvents } from './logging/logging-window.js';
import {
    externalStatusLogEvents,
    fileLogEvents,
    filesLogEvents,
    gitLogEvents,
    projectStatusLogEvents,
    watcherLogEvents,
    watchHubLogEvents,
    workbenchRootLogEvents,
    workbenchRootsLogEvents,
    workbenchSnapshotLogEvents,
} from './logging/logging-workspace.js';

/**
 * Canonical structured-log event registry. Writers use these values so adding or renaming an event is one reviewed,
 * browser-safe protocol change instead of an unchecked string scattered across Desktop processes.
 */
export const logEventCatalog = {
    mobileGateway: mobileGatewayLogEvents,
    agentChat: agentChatLogEvents,
    agent: agentLogEvents,
    agentDelegation: agentDelegationLogEvents,
    agentDispatch: agentDispatchLogEvents,
    agentEndpoint: agentEndpointLogEvents,
    agentHooks: agentHooksLogEvents,
    agentMessage: agentMessageLogEvents,
    agentSecrets: agentSecretLogEvents,
    agentNotifications: agentNotificationsLogEvents,
    app: appLogEvents,
    configuration: configLogEvents,
    database: databaseLogEvents,
    diagnostics: diagnosticsLogEvents,
    e2e: e2eLogEvents,
    extensionHost: extensionHostLogEvents,
    file: fileLogEvents,
    files: filesLogEvents,
    git: gitLogEvents,
    desktop: desktopLogEvents,
    externalStatus: externalStatusLogEvents,
    gpu: gpuLogEvents,
    ipc: ipcLogEvents,
    log: logLogEvents,
    pathBrowser: pathBrowserLogEvents,
    process: processLogEvents,
    loginShell: loginShellLogEvents,
    caxriBot: caxriBotLogEvents,
    agentChatSubagents: agentChatSubagentLogEvents,
    benchmark: benchmarkLogEvents,
    claudeWindow: claudeWindowLogEvents,
    benchmarkWindow: benchmarkWindowLogEvents,
    sshHost: sshHostLogEvents,
    performanceMonitor: performanceMonitorLogEvents,
    processExplorer: processExplorerLogEvents,
    projectStatus: projectStatusLogEvents,
    sessionAirplaneMode: sessionAirplaneModeLogEvents,
    sessionCompaction: sessionCompactionLogEvents,
    sessionContext: sessionContextLogEvents,
    sessionSearch: sessionSearchLogEvents,
    sessionRename: sessionRenameLogEvents,
    usage: usageLogEvents,
    sessionPullRequests: sessionPullRequestsLogEvents,
    pty: ptyLogEvents,
    renderer: rendererLogEvents,
    serverConnection: serverConnectionLogEvents,
    serverCore: serverCoreLogEvents,
    terminal: terminalLogEvents,
    terminalHost: terminalHostLogEvents,
    updates: updatesLogEvents,
    watcher: watcherLogEvents,
    watchHub: watchHubLogEvents,
    window: windowLogEvents,
    workbenchRoot: workbenchRootLogEvents,
    workbenchRoots: workbenchRootsLogEvents,
    workbenchSnapshot: workbenchSnapshotLogEvents,
} as const;

export type LogEventName = {
    [
        Group in keyof typeof logEventCatalog
    ]: (typeof logEventCatalog)[Group][keyof (typeof logEventCatalog)[Group]];
}[keyof typeof logEventCatalog];

export const logEventNames = Object.values(logEventCatalog).flatMap((group) =>
    Object.values(group),
) as [LogEventName, ...LogEventName[]];

export const logEventNameSchema = z.enum(logEventNames);
