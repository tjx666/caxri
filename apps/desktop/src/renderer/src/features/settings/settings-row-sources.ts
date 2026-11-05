import { agentProviderIds, settingsSpecByKey } from '@caxri/protocol';

import { providerSettingRows } from './provider-setting-rows';
import type { SettingRowSource, SettingSubcategorySource } from './setting-row-source';
import { lower, specRow, specSearchTerms } from './setting-row-source';

/**
 * General's themed cards, in display order.
 */
const generalGroups = {
    workspace: {
        kind: 'group',
        id: 'workspace',
        titleKey: 'settings.subcategory.general.workspace',
    },
    sessions: { kind: 'group', id: 'sessions', titleKey: 'settings.subcategory.general.sessions' },
    appearance: {
        kind: 'group',
        id: 'appearance',
        titleKey: 'settings.subcategory.general.appearance',
    },
    sidebar: { kind: 'group', id: 'sidebar', titleKey: 'settings.subcategory.general.sidebar' },
} as const satisfies Record<string, SettingSubcategorySource>;

/**
 * Every Settings row in display order, grouped by category.
 */
export const settingRowSources: SettingRowSource[] = [
    specRow('workbench.language', { subcategory: generalGroups.workspace }),
    specRow('workbench.externalEditor', { subcategory: generalGroups.workspace }),
    specRow('workbench.newWorktreeBehavior', {
        advanced: true,
        subcategory: generalGroups.workspace,
    }),
    specRow('workbench.confirmWorktreeAuthorization', {
        advanced: true,
        subcategory: generalGroups.workspace,
    }),
    specRow('workbench.removeWorktreeOnArchive', {
        advanced: true,
        subcategory: generalGroups.workspace,
    }),
    specRow('updates.skippedVersion', { advanced: true, subcategory: generalGroups.workspace }),
    specRow('session.defaultAgent', { subcategory: generalGroups.sessions }),
    specRow('session.openAgentsInChat', { subcategory: generalGroups.sessions }),
    {
        id: 'sessions.archived',
        category: 'general',
        subcategory: generalGroups.sessions,
        titleKey: 'settings.row.archivedSessions.title',
        descriptionKey: 'settings.row.archivedSessions.description',
        binding: { type: 'archived-sessions' },
        searchTerms: lower(['archived sessions', 'restore', 'delete', 'manage', 'history']),
    },
    specRow('statusBar.usage.limitWindows', {
        advanced: true,
        subcategory: generalGroups.sessions,
    }),
    specRow('workbench.theme.followSystem', { subcategory: generalGroups.appearance }),
    specRow('workbench.theme.light', {
        enabledBy: 'workbench.theme.followSystem',
        subcategory: generalGroups.appearance,
    }),
    specRow('workbench.theme.dark', {
        enabledBy: 'workbench.theme.followSystem',
        subcategory: generalGroups.appearance,
    }),
    specRow('workbench.fontFamily', { subcategory: generalGroups.appearance }),
    specRow('window.zoomLevel', { subcategory: generalGroups.appearance }),
    specRow('zen.fullScreen', { advanced: true, subcategory: generalGroups.appearance }),
    specRow('zen.restore', { advanced: true, subcategory: generalGroups.appearance }),
    specRow('primarySidebar.autoCollapseProjects', { subcategory: generalGroups.sidebar }),
    specRow('primarySidebar.showSubagents', { subcategory: generalGroups.sidebar }),
    specRow('primarySidebar.translucent', { subcategory: generalGroups.sidebar }),
    specRow('agentChat.longPasteThreshold', { advanced: true }),
    specRow('agentChat.workingIndicator', { advanced: true }),
    specRow('agentChat.animatedToolIcons', { advanced: true }),
    specRow('agentChat.statusShimmer', { advanced: true }),
    {
        id: 'hosts.machines',
        category: 'hosts',
        titleKey: 'settings.row.hosts.title',
        descriptionKey: 'settings.row.hosts.description',
        binding: { type: 'ssh-hosts' },
        searchTerms: lower([
            'hosts',
            'ssh',
            'remote',
            'machine',
            'display name',
            'icon',
            'reconnect on launch',
            'connect',
            'disconnect',
        ]),
    },
    {
        id: 'hosts.shouldShowHostNames',
        category: 'hosts',
        titleKey: 'settings.row.hostNames.title',
        descriptionKey: 'settings.row.hostNames.description',
        binding: { type: 'host-names' },
        searchTerms: lower(['host names', 'side bar', 'sidebar', 'icon', 'label']),
    },
    {
        id: 'mobile.access',
        category: 'mobile',
        titleKey: 'settings.row.mobileAccess.title',
        descriptionKey: 'settings.row.mobileAccess.description',
        binding: { type: 'mobile-access' },
        searchTerms: lower([
            'mobile access',
            'phone',
            'tablet',
            'android',
            'ios',
            'pair',
            'qr code',
            'local network',
        ]),
    },
    specRow('mobile.relayUrl', { advanced: true }),
    specRow('terminal.fontFamily'),
    specRow('terminal.fontSize'),
    {
        id: 'terminal.hardwareAcceleration',
        advanced: true,
        category: 'terminal',
        titleKey: 'settings.row.hardwareAcceleration.title',
        /**
         * Kept as its own setting rather than merged into Terminal hardware acceleration below (issue caxri#1289): it
         * gates the GPU for the whole app, Terminal hardware acceleration gates only the Terminal's WebGL renderer, and
         * the two can legitimately disagree: the Terminal setting can still be "on" while this is off, it just has
         * nothing to accelerate. Placed directly above it so the dependency reads in cause-then-effect order. Also says
         * what turning it off actually costs and what takes it back: the previous wording promised "Caxri never changes
         * this automatically", which stopped being true the moment a crash card could write it, so the promise is now
         * the accurate one: Caxri only changes it behind a confirmation the user answered.
         */
        descriptionKey: 'settings.row.hardwareAcceleration.description',
        binding: { type: 'hardware-acceleration' },
        searchTerms: lower([
            'hardware acceleration',
            'gpu',
            'graphics',
            'software rendering',
            'slow',
            'restart',
        ]),
    },
    specRow('terminal.gpuAcceleration', { advanced: true }),
    specRow('terminal.scrollback', { advanced: true }),
    specRow('terminal.longPasteThreshold', { advanced: true }),
    specRow('terminal.copyOnSelect'),
    specRow('terminal.osc52ClipboardWrite', { advanced: true }),
    specRow('terminal.wordSeparators', { advanced: true }),
    specRow('terminal.referenceLinks', {
        advanced: true,
        binding: { type: 'terminal-reference-links' },
    }),
    specRow('terminal.defaultWorkingDirectory', { advanced: true }),
    specRow('files.autoSave'),
    specRow('editor.fontFamily'),
    specRow('editor.fontSize'),
    specRow('editor.wordWrap'),
    specRow('editor.wordSeparators', { advanced: true }),
    specRow('editor.minimap.enabled'),
    specRow('editor.stickyScroll.enabled'),
    specRow('editor.bracketPairColorization.enabled', { advanced: true }),
    specRow('editor.guides.bracketPairs', { advanced: true }),
    specRow('editor.renderWhitespace', { advanced: true }),
    specRow('editor.linkedEditing', { advanced: true }),
    specRow('editor.autoClosingDelete', { advanced: true }),
    specRow('editor.stickyTabStops', { advanced: true }),
    specRow('editor.unfoldOnClickAfterEndOfLine', { advanced: true }),
    specRow('editor.foldOnOpenLineThreshold', { advanced: true }),
    specRow('editor.dragAndDrop', { advanced: true }),
    specRow('editor.cursorBlinking', { advanced: true }),
    specRow('editor.cursorSmoothCaretAnimation', { advanced: true }),
    specRow('editor.smoothScrolling', { advanced: true }),
    specRow('security.trustedDomains', {
        advanced: true,
        binding: { type: 'trusted-domains' },
    }),
    specRow('security.trustedFolders', {
        advanced: true,
        binding: { type: 'trusted-folders' },
    }),
    specRow('git.fetchGitHubAvatars', { advanced: true }),
    {
        id: 'security.remoteDebugging',
        advanced: true,
        category: 'security',
        titleKey: 'settings.row.remoteDebugging.title',
        descriptionKey: 'settings.row.remoteDebugging.description',
        binding: { type: 'remote-debugging' },
        searchTerms: lower([
            'remote debugging',
            'cdp',
            'chrome devtools protocol',
            'devtools',
            'port 9224',
            'port 9223',
            'inspect',
            'attach',
            'automation',
        ]),
    },
    specRow('files.exclude', {
        advanced: true,
        binding: { type: 'files-exclude', key: 'files.exclude' },
    }),
    specRow('git.diffExclude', {
        advanced: true,
        binding: { type: 'files-exclude', key: 'git.diffExclude' },
    }),
    specRow('files.maxFileBytes', { advanced: true }),
    specRow('projectStatus.ignoredChecks', {
        advanced: true,
        binding: { type: 'ignored-checks' },
    }),
    specRow('projectStatus.notifyAgentOnMerge'),
    specRow('projectStatus.autoArchiveOnPullRequestSettled'),
    specRow('notifications.worktreeFallback'),
    specRow('notifications.agentRecovery'),
    specRow('environmentMonitor.publicIpChanges', { advanced: true }),
    specRow('environmentMonitor.expectedTimeZone', { advanced: true }),
    specRow('environmentMonitor.mihomoRoutes', { advanced: true }),
    specRow('projectStatus.notifications.enabled'),
    {
        id: 'agents.secrets',
        category: 'agents',
        titleKey: 'settings.row.agentSecrets.title',
        descriptionKey: 'settings.row.agentSecrets.description',
        binding: { type: 'agent-secrets' },
        searchTerms: lower([
            'secrets',
            'api key',
            'token',
            'password',
            'credential',
            'environment variable',
            'caxri secret',
        ]),
    },
    {
        id: 'agents.delegation.presets',
        category: 'agents',
        titleKey: 'settings.row.delegationPresets.title',
        descriptionKey: 'settings.row.delegationPresets.description',
        binding: { type: 'delegation-presets' },
        searchSpec: 'agents.delegation',
        searchTerms: lower([
            'dianjiang',
            'import',
            'presets',
            'delegation',
            'delegate',
            'model',
            'effort',
        ]),
    },
    {
        id: 'agents.delegation.maxDepth',
        advanced: true,
        category: 'agents',
        titleKey: 'settings.row.delegationDepth.title',
        descriptionKey: 'settings.row.delegationDepth.description',
        /**
         * The worked example and the pointer to where delegation presets are edited both matter, but together they
         * wrapped this row to four lines (issue caxri#1289). Moved behind the row's info affordance so the one-line
         * description stays the thing every reader sees.
         */
        detailKey: 'settings.row.delegationDepth.detail',
        binding: { type: 'delegation-field', field: 'maxDepth' },
        /**
         * Derived from the one spec that already describes this key, so the words it lists (`model`, `effort`,
         * `caller`) keep finding the row instead of dying with the complex editor this row replaced.
         */
        searchSpec: 'agents.delegation',
        searchTerms: specSearchTerms(settingsSpecByKey['agents.delegation'], [
            'delegation depth',
            'delegate',
            'max depth',
            'subagent',
            'helper',
            'hand off',
        ]),
    },
    {
        id: 'agents.delegation.readChildChat',
        advanced: true,
        category: 'agents',
        titleKey: 'settings.row.delegationReadChildChat.title',
        descriptionKey: 'settings.row.delegationReadChildChat.description',
        binding: { type: 'delegation-field', field: 'readChildChat' },
        searchTerms: lower([
            'delegation transcript',
            'read child chat',
            'delegate',
            'subagent',
            'conversation',
            'progress',
        ]),
    },
    {
        id: 'agents.delegation.approval',
        advanced: true,
        category: 'agents',
        titleKey: 'settings.row.delegationApproval.title',
        descriptionKey: 'settings.row.delegationApproval.description',
        binding: { type: 'delegation-field', field: 'approval' },
        searchTerms: lower([
            'parent approval',
            'approve',
            'permission request',
            'delegate',
            'subagent',
            'helper',
        ]),
    },
    {
        id: 'agents.delegation.autoHandBack',
        category: 'agents',
        titleKey: 'settings.row.delegationAutoHandBack.title',
        descriptionKey: 'settings.row.delegationAutoHandBack.description',
        binding: { type: 'delegation-field', field: 'autoHandBack' },
        searchTerms: lower([
            'hand back',
            'take over',
            'takeover',
            'delegate',
            'subagent',
            'away',
            'idle',
        ]),
    },
    specRow('agents.longRunningShellCommands', {
        advanced: true,
        binding: { type: 'long-running-commands' },
    }),
    specRow('agents.sessionInstructions', { advanced: true }),
    specRow('agents.suggestLifecycleHooks', { advanced: true }),
    specRow('agents.notifications.enabled'),
    specRow('agents.notifications.completionThresholdSeconds'),
    specRow('terminal.suspendUntouchedAgents', { advanced: true }),
    specRow('terminal.idleSuspension.enabled', { advanced: true }),
    specRow('terminal.idleSuspension.afterMinutes', {
        advanced: true,
        enabledBy: 'terminal.idleSuspension.enabled',
    }),
    specRow('agentChat.idleCompaction.enabled', { advanced: true }),
    specRow('agentChat.awayRecap.enabled'),
    specRow('agentChat.autoContinueAtUsageLimit'),
    ...agentProviderIds.flatMap((provider) => providerSettingRows(provider)),
];
