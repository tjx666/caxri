import type { AgentProvider, SettingCategoryId, SettingKey, SettingSpec } from '@caxri/protocol';
import {
    agentProviderCatalog,
    agentProviderIds,
    settingCategories,
    settingsSpecByKey,
} from '@caxri/protocol';

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
          field: 'hooks' | 'messaging' | 'naming' | 'pasteSummary';
      }
    | { type: 'provider-recovery'; provider: AgentProvider }
    | { type: 'provider-launch'; provider: AgentProvider; field: 'executable' | 'args' }
    | { type: 'provider-actions'; provider: AgentProvider }
    | { type: 'provider-skill-health'; provider: AgentProvider }
    | { type: 'trusted-domains' }
    | { type: 'terminal-reference-links' }
    | { type: 'files-exclude' }
    | { type: 'archived-sessions' }
    | { type: 'mobile-access' }
    | { type: 'remote-debugging' }
    | { type: 'hardware-acceleration' };

export interface SettingRowDescriptor {
    /**
     * Stable unique id: the settings key, or a purpose-named id for non-settings rows.
     */
    id: string;
    category: SettingCategoryId;
    /**
     * Secondary grouping rendered as an inline heading and an indented TOC entry (Agents).
     */
    subcategory?: string;
    title: string;
    description?: string;
    binding: SettingRowBinding;
    /**
     * Lowercased text corpus the settings search matches against.
     */
    haystack: string;
}

export interface SettingsCategory {
    id: SettingCategoryId;
    title: string;
    subcategories: string[];
}

const lower = (values: Array<string | undefined>): string =>
    values
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();

function specHaystack(spec: SettingSpec, extra: Array<string | undefined> = []): string {
    return lower([
        spec.title,
        spec.description,
        spec.key,
        ...(spec.keywords ?? []),
        ...(spec.kind === 'enum' ? spec.options.map((option) => option.label) : []),
        ...extra,
    ]);
}

function specRow(key: SettingKey, extra?: Partial<SettingRowDescriptor>): SettingRowDescriptor {
    const spec: SettingSpec = settingsSpecByKey[key];
    return {
        id: spec.key,
        category: spec.category,
        title: spec.title,
        description: spec.description,
        binding: { type: 'setting', key },
        haystack: specHaystack(spec),
        ...extra,
    };
}

function providerRows(provider: AgentProvider): SettingRowDescriptor[] {
    const providerName = agentProviderCatalog[provider].displayName;
    const shared = { category: 'agents' as const, subcategory: providerName };
    const providerTerms = [provider, providerName, 'agent', 'provider'];
    return [
        {
            ...shared,
            id: `agents.${provider}.actions`,
            title: 'Agent commands & skills',
            description:
                'Customize slash commands and skill invocations shown in the Agent Commands & Skills picker. ' +
                'Project and user skills are discovered automatically.',
            binding: { type: 'provider-actions', provider },
            haystack: lower([
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
            title: 'Lifecycle hooks',
            description:
                'Keeps background Session unread state accurate. Caxri only receives lifecycle ' +
                'phases, never prompt or response content. Restart Agent Terminals opened before ' +
                'lifecycle hooks were enabled.',
            binding: { type: 'provider-toggle', provider, field: 'hooks' },
            haystack: lower(['lifecycle hooks', 'unread', 'background', ...providerTerms]),
        },
        ...(agentProviderCatalog[provider].automaticSessionNaming === 'caxri'
            ? [
                  {
                      ...shared,
                      id: `agents.${provider}.naming`,
                      title: 'Automatic Session naming',
                      description:
                          'Uses one extra low-cost model call after eligible turns. Requires Lifecycle ' +
                          'hooks, takes effect on the next turn, and leaves the current title unchanged ' +
                          'if generation fails.',
                      binding: {
                          type: 'provider-toggle' as const,
                          provider,
                          field: 'naming' as const,
                      },
                      haystack: lower([
                          'automatic session naming',
                          'rename',
                          'title',
                          'model call',
                          ...providerTerms,
                      ]),
                  },
              ]
            : []),
        {
            ...shared,
            id: `agents.${provider}.messaging`,
            title: 'Peer messaging',
            description:
                'Lets this managed Agent exchange bounded peer text through the Caxri Inbox. It ' +
                'never pastes messages into the Terminal. Disabling takes effect immediately ' +
                'without stopping the Terminal; restart only if the CLI adapter is unavailable.',
            binding: { type: 'provider-toggle', provider, field: 'messaging' },
            haystack: lower(['peer messaging', 'inbox', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.pasteSummary`,
            title: 'Summarize long pastes',
            description:
                'Saves long pasted text locally and uses one extra low-cost model call before inserting a summary and file path. Disable this to keep ordinary paste behavior.',
            binding: { type: 'provider-toggle', provider, field: 'pasteSummary' },
            haystack: lower([
                'summarize long pastes',
                'clipboard',
                'context',
                'model call',
                ...providerTerms,
            ]),
        },
        {
            ...shared,
            id: `agents.${provider}.recovery`,
            title: 'Network error recovery',
            description:
                'After parsed Terminal output ends with a built-in provider rule or one of your ' +
                'additional patterns, waits, sends Esc, then waits again and submits continue. ' +
                'Disabled by default.',
            binding: { type: 'provider-recovery', provider },
            haystack: lower([
                'network error recovery',
                'timeout',
                'retry failed',
                'escape',
                'continue',
                ...providerTerms,
            ]),
        },
        {
            ...shared,
            id: `agents.${provider}.skill`,
            title: 'Caxri CLI skill',
            description: 'Installation health of the bundled Caxri skill for this provider',
            binding: { type: 'provider-skill-health', provider },
            haystack: lower(['skill', 'cli', 'health', 'install', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.executable`,
            title: 'Executable',
            description: 'Command used to launch this Agent in new Terminals',
            binding: { type: 'provider-launch', provider, field: 'executable' },
            haystack: lower(['executable', 'command', 'launch', 'path', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.args`,
            title: 'Initial arguments',
            description: 'One argument per line, passed on every launch',
            binding: { type: 'provider-launch', provider, field: 'args' },
            haystack: lower(['arguments', 'args', 'flags', 'launch', ...providerTerms]),
        },
    ];
}

const categoryTitles = Object.fromEntries(
    settingCategories.map((category) => [category.id, category.title]),
) as Record<SettingCategoryId, string>;

const rows: SettingRowDescriptor[] = [
    specRow('session.defaultAgent'),
    specRow('primarySidebar.autoCollapseProjects'),
    specRow('workbench.newWorktreeBehavior'),
    specRow('workbench.fontFamily'),
    specRow('workbench.externalEditor'),
    {
        id: 'general.hardwareAcceleration',
        category: 'general',
        title: 'Hardware acceleration',
        description:
            'Uses the GPU for Caxri rendering. Turn it off to use GPU Safe Mode; Caxri never changes this automatically. Changes take effect after restarting Caxri',
        binding: { type: 'hardware-acceleration' },
        haystack: lower([
            'hardware acceleration',
            'gpu',
            'gpu safe mode',
            'software rendering',
            'restart',
        ]),
    },
    {
        id: 'sessions.archived',
        category: 'general',
        title: 'Archived Sessions',
        description: 'Restore or permanently delete archived Sessions',
        binding: { type: 'archived-sessions' },
        haystack: lower(['archived sessions', 'restore', 'delete', 'manage', 'history']),
    },
    {
        id: 'mobile.access',
        category: 'mobile',
        title: 'Mobile access',
        description:
            'Pair phones and tablets on this local network to review scoped Agent Sessions and send short replies',
        binding: { type: 'mobile-access' },
        haystack: lower([
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
    specRow('terminal.fontFamily'),
    specRow('terminal.fontSize'),
    specRow('terminal.gpuAcceleration'),
    specRow('terminal.scrollback'),
    specRow('terminal.longPasteThreshold'),
    specRow('terminal.copyOnSelect'),
    specRow('terminal.suspendUntouchedAgents'),
    specRow('terminal.suspendIdleAgents'),
    specRow('terminal.osc52ClipboardWrite'),
    specRow('terminal.wordSeparators'),
    {
        ...specRow('terminal.referenceLinks'),
        binding: { type: 'terminal-reference-links' },
    },
    specRow('terminal.defaultWorkingDirectory'),
    specRow('editor.fontFamily'),
    {
        ...specRow('security.trustedDomains'),
        binding: { type: 'trusted-domains' },
    },
    specRow('git.fetchGitHubAvatars'),
    {
        id: 'security.remoteDebugging',
        category: 'security',
        title: 'Remote debugging (CDP)',
        description:
            'Expose Chrome DevTools Protocol on 127.0.0.1:9224 (9223 in dev launches) for agent ' +
            'tooling; takes effect after restarting Caxri',
        binding: { type: 'remote-debugging' },
        haystack: lower([
            'remote debugging',
            'cdp',
            'chrome devtools protocol',
            'port 9224',
            'port 9223',
            'inspect',
        ]),
    },
    {
        ...specRow('files.exclude'),
        binding: { type: 'files-exclude' },
    },
    specRow('files.maxFileBytes'),
    specRow('agents.notifications.enabled'),
    specRow('agents.notifications.completionThresholdSeconds'),
    ...agentProviderIds.flatMap((provider) => providerRows(provider)),
];

/**
 * Display-order authority for the Settings page: rows grouped by category, flattened top to bottom. The table of
 * contents, the virtualized list, and search all derive from this array. Category and subcategory titles join each
 * row's haystack so "terminal" or "claude" matches the whole group.
 */
export const settingsRows: SettingRowDescriptor[] = rows.map((row) => ({
    ...row,
    haystack: lower([row.haystack, categoryTitles[row.category], row.subcategory]),
}));

/**
 * Resolves a subcategory heading back to its Agent provider for identity icons.
 */
export function agentProviderForSubcategory(title: string): AgentProvider | undefined {
    return agentProviderIds.find(
        (provider) => agentProviderCatalog[provider].displayName === title,
    );
}

/**
 * Categories in display order, each with its ordered distinct subcategories.
 */
export const settingsCategories: SettingsCategory[] = settingCategories.map((category) => ({
    id: category.id,
    title: category.title,
    subcategories: [
        ...new Set(
            settingsRows.flatMap((row) =>
                row.category === category.id && row.subcategory !== undefined
                    ? [row.subcategory]
                    : [],
            ),
        ),
    ],
}));
