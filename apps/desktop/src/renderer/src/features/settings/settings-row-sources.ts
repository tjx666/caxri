import type { AgentProvider, SettingCategoryId, SettingKey, SettingSpec } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, settingsSpecByKey } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

/**
 * How a Settings row reads and writes its value. Scalar `settings.jsonc` fields render a generic control from their
 * spec; everything else (argv-backed toggles, provider sub-fields, dedicated editors, action buttons) declares an
 * explicit binding the row renderer dispatches on.
 */
export type SettingRowBinding =
    | { type: 'setting'; key: SettingKey }
    | {
          type: 'provider-toggle';
          provider: AgentProvider;
          field: 'hooks' | 'messaging';
      }
    | { type: 'provider-recovery'; provider: AgentProvider }
    | { type: 'provider-autonomy'; provider: AgentProvider }
    | { type: 'provider-launch'; provider: AgentProvider; field: 'executable' | 'args' }
    | { type: 'provider-actions'; provider: AgentProvider }
    | { type: 'provider-skill-health'; provider: AgentProvider }
    | { type: 'trusted-domains' }
    | { type: 'trusted-folders' }
    | { type: 'terminal-reference-links' }
    | { type: 'ignored-checks' }
    | { type: 'long-running-commands' }
    | { type: 'files-exclude'; key: 'files.exclude' | 'git.diffExclude' }
    | { type: 'archived-sessions' }
    | { type: 'mobile-access' }
    | { type: 'claude-windows' }
    | { type: 'agent-secrets' }
    | { type: 'delegation-depth' }
    | { type: 'remote-debugging' }
    | { type: 'hardware-acceleration' };

/**
 * A row as declared, before the registry translates it for a locale. Visible text is stored as translation keys so the
 * registry can render it in the active language; `searchTerms` holds the English corpus (the protocol catalog's text,
 * its keywords, and hand-picked synonyms), which stays searchable in every language.
 */
export interface SettingRowSource {
    /**
     * Stable unique id: the settings key, or a purpose-named id for non-settings rows.
     */
    id: string;
    category: SettingCategoryId;
    /**
     * Secondary grouping rendered as an inline heading and an indented TOC entry (Agents). Provider names, which are
     * never translated.
     */
    subcategory?: string;
    titleKey: TranslationKey;
    descriptionKey?: TranslationKey;
    detailKey?: TranslationKey;
    /**
     * A boolean setting this row only applies under. While that switch is off the row's control is disabled, so a
     * dependent value (Suspend idle Agents after) cannot read as if it were in force. Honored by the generic boolean
     * and integer controls of a `setting` binding.
     */
    enabledBy?: SettingKey;
    binding: SettingRowBinding;
    /**
     * Catalog entry whose translated text (title, description, option labels) also joins the row's search corpus.
     */
    searchSpec?: SettingKey;
    /**
     * English search corpus, lowercased.
     */
    searchTerms: string;
}

type DescribedSettingKey = Extract<
    (typeof settingsSpecByKey)[SettingKey],
    { description: string }
>['key'];

export const lower = (values: Array<string | undefined>): string =>
    values
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();

function specSearchTerms(spec: SettingSpec, extra: string[] = []): string {
    return lower([
        spec.title,
        spec.description,
        spec.key,
        ...(spec.keywords ?? []),
        ...(spec.kind === 'enum' ? spec.options.map((option) => option.label) : []),
        ...extra,
    ]);
}

function specRow(key: SettingKey, extra?: Partial<SettingRowSource>): SettingRowSource {
    const spec: SettingSpec = settingsSpecByKey[key];
    return {
        id: spec.key,
        category: spec.category,
        titleKey: `settings.${key}.title`,
        descriptionKey:
            spec.description === undefined
                ? undefined
                : `settings.${key as DescribedSettingKey}.description`,
        binding: { type: 'setting', key },
        searchSpec: key,
        searchTerms: specSearchTerms(spec),
        ...extra,
    };
}

function providerRows(provider: AgentProvider): SettingRowSource[] {
    const providerName = agentProviderCatalog[provider].displayName;
    const shared = { category: 'agents' as const, subcategory: providerName };
    const providerTerms = [provider, providerName, 'agent', 'provider'];
    return [
        {
            ...shared,
            id: `agents.${provider}.actions`,
            titleKey: 'settings.row.providerActions.title',
            descriptionKey: 'settings.row.providerActions.description',
            binding: { type: 'provider-actions', provider },
            searchTerms: lower([
                'agent actions',
                'agent commands & skills',
                'slash commands',
                'skills',
                'picker',
                ...providerTerms,
            ]),
        },
        {
            ...shared,
            id: `agents.${provider}.hooks`,
            titleKey: 'settings.row.providerHooks.title',
            descriptionKey: 'settings.row.providerHooks.description',
            binding: { type: 'provider-toggle', provider, field: 'hooks' },
            searchTerms: lower(['lifecycle hooks', 'unread', 'background', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.messaging`,
            titleKey: 'settings.row.providerMessaging.title',
            descriptionKey: 'settings.row.providerMessaging.description',
            binding: { type: 'provider-toggle', provider, field: 'messaging' },
            searchTerms: lower(['peer messaging', 'inbox', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.recovery`,
            titleKey: 'settings.row.providerRecovery.title',
            descriptionKey: 'settings.row.providerRecovery.description',
            binding: { type: 'provider-recovery', provider },
            searchTerms: lower([
                'network error recovery',
                'timeout',
                'retry failed',
                'escape',
                'continue',
                ...providerTerms,
            ]),
        },
        ...(provider === 'claude'
            ? [
                  {
                      ...shared,
                      id: 'agents.claude.windows',
                      titleKey: 'settings.row.claudeWindows.title',
                      descriptionKey: 'settings.row.claudeWindows.description',
                      binding: { type: 'claude-windows' },
                      searchTerms: lower([
                          '5-hour windows',
                          'keep 5-hour windows rolling',
                          'first workday reset at',
                          'rate limit',
                          'usage limit',
                          'reset',
                          'warm-up',
                          'subscription',
                          ...providerTerms,
                      ]),
                  } satisfies SettingRowSource,
              ]
            : []),
        {
            ...shared,
            id: `agents.${provider}.skill`,
            titleKey: 'settings.row.providerSkill.title',
            descriptionKey: 'settings.row.providerSkill.description',
            binding: { type: 'provider-skill-health', provider },
            searchTerms: lower(['skill', 'cli', 'health', 'install', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.executable`,
            titleKey: 'settings.row.providerExecutable.title',
            descriptionKey: 'settings.row.providerExecutable.description',
            binding: { type: 'provider-launch', provider, field: 'executable' },
            searchTerms: lower(['executable', 'command', 'launch', 'path', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.autonomy`,
            titleKey: 'settings.row.providerAutonomy.title',
            descriptionKey: 'settings.row.providerAutonomy.description',
            binding: { type: 'provider-autonomy', provider },
            searchTerms: lower([
                'act without asking each time',
                'permission',
                'permissions',
                'approval',
                'approve',
                'ask',
                'confirm',
                'autonomy',
                'unattended',
                ...providerTerms,
            ]),
        },
        {
            ...shared,
            id: `agents.${provider}.args`,
            titleKey: 'settings.row.providerArgs.title',
            descriptionKey: 'settings.row.providerArgs.description',
            binding: { type: 'provider-launch', provider, field: 'args' },
            searchTerms: lower([
                'arguments',
                'args',
                'flags',
                'launch',
                'command line',
                ...providerTerms,
            ]),
        },
    ];
}

/**
 * Every Settings row in display order, grouped by category.
 */
export const settingRowSources: SettingRowSource[] = [
    specRow('workbench.language'),
    specRow('session.defaultAgent'),
    specRow('session.openAgentsInChat'),
    specRow('workbench.externalEditor'),
    specRow('workbench.theme.followSystem'),
    specRow('workbench.theme.light', { enabledBy: 'workbench.theme.followSystem' }),
    specRow('workbench.theme.dark', { enabledBy: 'workbench.theme.followSystem' }),
    specRow('primarySidebar.autoCollapseProjects'),
    specRow('primarySidebar.showSubagents'),
    specRow('primarySidebar.translucent'),
    specRow('zen.fullScreen'),
    specRow('zen.restore'),
    specRow('statusBar.usage.limitWindows'),
    specRow('workbench.newWorktreeBehavior'),
    specRow('workbench.confirmWorktreeAuthorization'),
    specRow('workbench.removeWorktreeOnArchive'),
    specRow('workbench.fontFamily'),
    specRow('window.zoomLevel'),
    specRow('updates.skippedVersion'),
    specRow('agentChat.longPasteThreshold'),
    specRow('agentChat.workingIndicator'),
    specRow('agentChat.animatedToolIcons'),
    specRow('agentChat.statusShimmer'),
    {
        id: 'sessions.archived',
        category: 'general',
        titleKey: 'settings.row.archivedSessions.title',
        descriptionKey: 'settings.row.archivedSessions.description',
        binding: { type: 'archived-sessions' },
        searchTerms: lower(['archived sessions', 'restore', 'delete', 'manage', 'history']),
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
    specRow('mobile.relayUrl'),
    specRow('terminal.fontFamily'),
    specRow('terminal.fontSize'),
    {
        id: 'terminal.hardwareAcceleration',
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
    specRow('terminal.gpuAcceleration'),
    specRow('terminal.scrollback'),
    specRow('terminal.longPasteThreshold'),
    specRow('terminal.copyOnSelect'),
    specRow('terminal.osc52ClipboardWrite'),
    specRow('terminal.wordSeparators'),
    specRow('terminal.referenceLinks', { binding: { type: 'terminal-reference-links' } }),
    specRow('terminal.defaultWorkingDirectory'),
    specRow('files.autoSave'),
    specRow('editor.fontFamily'),
    specRow('editor.fontSize'),
    specRow('editor.wordWrap'),
    specRow('editor.wordSeparators'),
    specRow('editor.minimap.enabled'),
    specRow('editor.stickyScroll.enabled'),
    specRow('editor.bracketPairColorization.enabled'),
    specRow('editor.guides.bracketPairs'),
    specRow('editor.renderWhitespace'),
    specRow('editor.linkedEditing'),
    specRow('editor.autoClosingDelete'),
    specRow('editor.stickyTabStops'),
    specRow('editor.unfoldOnClickAfterEndOfLine'),
    specRow('editor.foldOnOpenLineThreshold'),
    specRow('editor.dragAndDrop'),
    specRow('editor.cursorBlinking'),
    specRow('editor.cursorSmoothCaretAnimation'),
    specRow('editor.smoothScrolling'),
    specRow('security.trustedDomains', { binding: { type: 'trusted-domains' } }),
    specRow('security.trustedFolders', { binding: { type: 'trusted-folders' } }),
    specRow('git.fetchGitHubAvatars'),
    {
        id: 'security.remoteDebugging',
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
    specRow('files.exclude', { binding: { type: 'files-exclude', key: 'files.exclude' } }),
    specRow('git.diffExclude', { binding: { type: 'files-exclude', key: 'git.diffExclude' } }),
    specRow('files.maxFileBytes'),
    specRow('projectStatus.ignoredChecks', { binding: { type: 'ignored-checks' } }),
    specRow('projectStatus.notifyAgentOnMerge'),
    specRow('projectStatus.autoArchiveOnPullRequestSettled'),
    specRow('notifications.worktreeFallback'),
    specRow('notifications.agentRecovery'),
    specRow('environmentMonitor.publicIpChanges'),
    specRow('environmentMonitor.expectedTimeZone'),
    specRow('environmentMonitor.mihomoRoutes'),
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
        id: 'agents.delegation.maxDepth',
        category: 'agents',
        titleKey: 'settings.row.delegationDepth.title',
        descriptionKey: 'settings.row.delegationDepth.description',
        /**
         * The worked example and the pointer to where delegation presets are edited both matter, but together they
         * wrapped this row to four lines (issue caxri#1289). Moved behind the row's info affordance so the one-line
         * description stays the thing every reader sees.
         */
        detailKey: 'settings.row.delegationDepth.detail',
        binding: { type: 'delegation-depth' },
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
    specRow('agents.longRunningShellCommands', { binding: { type: 'long-running-commands' } }),
    specRow('agents.sessionInstructions'),
    specRow('agents.suggestLifecycleHooks'),
    specRow('agents.notifications.enabled'),
    specRow('agents.notifications.completionThresholdSeconds'),
    specRow('terminal.suspendUntouchedAgents'),
    specRow('terminal.idleSuspension.enabled'),
    specRow('terminal.idleSuspension.afterMinutes', {
        enabledBy: 'terminal.idleSuspension.enabled',
    }),
    specRow('agentChat.idleCompaction.enabled'),
    specRow('agentChat.autoContinueAtUsageLimit'),
    ...agentProviderIds.flatMap((provider) => providerRows(provider)),
];
