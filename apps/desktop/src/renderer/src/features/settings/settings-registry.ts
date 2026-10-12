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
    | { type: 'files-exclude'; key: 'files.exclude' | 'git.diffExclude' }
    | { type: 'archived-sessions' }
    | { type: 'mobile-access' }
    | { type: 'delegation-depth' }
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
    /**
     * Accessible name for the row's control, which is `title` unless another row shares it.
     *
     * The Settings page is one flat virtualized list, so a category heading is a sibling of its rows rather than a
     * container that owns them. Assistive technology therefore reads a control's name with no trace of the heading
     * above it, and "Font size" under Terminal is indistinguishable from "Font size" under Editor. A duplicated title
     * is prefixed with its category so the name stays unique app-wide; the visible label keeps the short title, which
     * WCAG 2.5.3 allows because the accessible name still contains it.
     */
    accessibleTitle: string;
    description?: string;
    /**
     * Longer explanation shown from an inline info affordance next to the title, for a row whose `description` was
     * shortened to fit its row height but still owes the reader the mechanics it dropped (e.g. Delegation depth's
     * worked examples). Most rows have no `detail` and rely on `description` alone.
     */
    detail?: string;
    /**
     * A boolean setting this row only applies under. While that switch is off the row's control is disabled, so a
     * dependent value (Pause idle Agents after) cannot read as if it were in force. Honored by the generic boolean and
     * integer controls of a `setting` binding.
     */
    enabledBy?: SettingKey;
    binding: SettingRowBinding;
    /**
     * Lowercased text corpus the settings search matches against.
     */
    haystack: string;
}

/**
 * A row before the registry resolves its accessible name, which can only be decided once every row is known.
 */
type SettingRowSource = Omit<SettingRowDescriptor, 'accessibleTitle'>;

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

function specRow(key: SettingKey, extra?: Partial<SettingRowSource>): SettingRowSource {
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

function providerRows(provider: AgentProvider): SettingRowSource[] {
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
        {
            ...shared,
            id: `agents.${provider}.messaging`,
            title: 'Peer messaging',
            description:
                'Lets this Agent send and receive short messages with other Agents through the ' +
                'Peer Inbox. Messages are never typed into the Terminal. Turning this off takes ' +
                'effect immediately; restart the Terminal only if messaging stays unavailable.',
            binding: { type: 'provider-toggle', provider, field: 'messaging' },
            haystack: lower(['peer messaging', 'inbox', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.recovery`,
            title: 'Network error recovery',
            description:
                'When the Agent stops on a network error Caxri recognizes, or on one of your ' +
                'extra patterns, Caxri waits, presses Esc, waits again, and sends “continue”. ' +
                'Off by default.',
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
            id: `agents.${provider}.autonomy`,
            title: 'Let the Agent act without asking each time',
            description:
                'On, this Agent edits files and runs commands in its Terminal without stopping ' +
                'for your approval each time. Off, it asks before each action. Applies to ' +
                'Terminals started from now on, not ones already running.',
            binding: { type: 'provider-autonomy', provider },
            haystack: lower([
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
            title: 'Initial arguments',
            description:
                'Passed on every launch. Write flags the way you would on the command line; a flag and its value can share a line.',
            binding: { type: 'provider-launch', provider, field: 'args' },
            haystack: lower([
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

const categoryTitles = Object.fromEntries(
    settingCategories.map((category) => [category.id, category.title]),
) as Record<SettingCategoryId, string>;

const rows: SettingRowSource[] = [
    specRow('session.defaultAgent'),
    specRow('session.openAgentsInChat'),
    specRow('primarySidebar.autoCollapseProjects'),
    specRow('workbench.newWorktreeBehavior'),
    specRow('workbench.fontFamily'),
    specRow('window.zoomLevel'),
    specRow('workbench.externalEditor'),
    specRow('updates.skippedVersion'),
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
    {
        id: 'terminal.hardwareAcceleration',
        category: 'terminal',
        title: 'Hardware acceleration',
        /**
         * Kept as its own setting rather than merged into GPU acceleration below (issue caxri#1289): it gates the GPU
         * for the whole app, GPU acceleration gates only the Terminal's WebGL renderer, and the two can legitimately
         * disagree: GPU acceleration can still be "on" while this is off, it just has nothing to accelerate. Placed
         * directly above it so the dependency reads in cause-then-effect order. Also says what turning it off actually
         * costs and what takes it back: the previous wording promised "Caxri never changes this automatically", which
         * stopped being true the moment a crash card could write it, so the promise is now the accurate one: Caxri only
         * changes it behind a confirmation the user answered.
         */
        description:
            "Controls whether the whole app draws with your graphics hardware, including every Terminal's GPU " +
            'acceleration below. Off, Caxri uses software rendering, which is slower but keeps working when ' +
            'graphics fail. Caxri only changes this after you confirm it, and a change takes effect after a restart.',
        binding: { type: 'hardware-acceleration' },
        haystack: lower([
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
    {
        ...specRow('terminal.referenceLinks'),
        binding: { type: 'terminal-reference-links' },
    },
    specRow('terminal.defaultWorkingDirectory'),
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
    {
        ...specRow('security.trustedDomains'),
        binding: { type: 'trusted-domains' },
    },
    {
        ...specRow('security.trustedFolders'),
        binding: { type: 'trusted-folders' },
    },
    specRow('git.fetchGitHubAvatars'),
    {
        id: 'security.remoteDebugging',
        category: 'security',
        title: 'Debugging port',
        description:
            'On, Caxri listens on 127.0.0.1:9224 and any program running on this Mac can attach ' +
            'to it over the Chrome DevTools Protocol. Whatever attaches can read every window, ' +
            'run code in it, and act as you. Nothing on another machine can reach that address. ' +
            'Off, nothing is listening. Applies to the installed app the next time it starts; a ' +
            'Caxri started from source always listens, on 127.0.0.1:9223.',
        binding: { type: 'remote-debugging' },
        haystack: lower([
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
    {
        ...specRow('files.exclude'),
        binding: { type: 'files-exclude', key: 'files.exclude' },
    },
    {
        ...specRow('git.diffExclude'),
        binding: { type: 'files-exclude', key: 'git.diffExclude' },
    },
    specRow('files.maxFileBytes'),
    {
        ...specRow('projectStatus.ignoredChecks'),
        binding: { type: 'ignored-checks' },
    },
    specRow('projectStatus.notifyAgentOnMerge'),
    specRow('notifications.worktreeFallback'),
    specRow('notifications.agentRecovery'),
    specRow('projectStatus.notifications.enabled'),
    {
        id: 'agents.delegation.maxDepth',
        category: 'agents',
        title: 'Delegation depth',
        description: 'How many times in a row an Agent may hand part of its job to another Agent.',
        /**
         * The worked example and the pointer to where delegation presets are edited both matter, but together they
         * wrapped this row to four lines (issue caxri#1289). Moved behind the row's info affordance so the one-line
         * `description` above stays the thing every reader sees.
         */
        detail:
            '1 lets the Agent you started bring in one helper, which then finishes alone; 2 lets ' +
            'that helper bring in one more. Which Agents may be brought in is set by the ' +
            'delegation presets, in the Source view.',
        binding: { type: 'delegation-depth' },
        /**
         * Derived from the one spec that already describes this key, so the words it lists (`model`, `effort`,
         * `caller`) keep finding the row instead of dying with the complex editor this row replaced.
         */
        haystack: specHaystack(settingsSpecByKey['agents.delegation'], [
            'delegate',
            'max depth',
            'subagent',
            'helper',
            'hand off',
        ]),
    },
    specRow('agents.notifications.enabled'),
    specRow('agents.notifications.completionThresholdSeconds'),
    specRow('terminal.suspendUntouchedAgents'),
    specRow('terminal.idleSuspension.enabled'),
    specRow('terminal.idleSuspension.afterMinutes', {
        enabledBy: 'terminal.idleSuspension.enabled',
    }),
    ...agentProviderIds.flatMap((provider) => providerRows(provider)),
];

/**
 * Bindings whose control takes its accessible name from the row title, and therefore need a category prefix when two
 * rows share that title. Every other binding renders a dedicated editor that already names itself after the thing it
 * edits (`Claude Code lifecycle hooks`), so prefixing it would rename a row that was never ambiguous. Keep this in step
 * with the `row.accessibleTitle` uses in `setting-row.tsx`.
 */
export const titleNamedBindings = new Set<SettingRowBinding['type']>([
    'delegation-depth',
    'hardware-acceleration',
    'remote-debugging',
    'setting',
]);

/**
 * Display-order authority for the Settings page: rows grouped by category, flattened top to bottom. The table of
 * contents, the virtualized list, and search all derive from this array. Category and subcategory titles join each
 * row's haystack so "terminal" or "claude" matches the whole group.
 */
export const settingsRows: SettingRowDescriptor[] = (() => {
    const titleCounts = new Map<string, number>();
    for (const row of rows)
        if (titleNamedBindings.has(row.binding.type))
            titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + 1);
    return rows.map((row) => ({
        ...row,
        accessibleTitle:
            (titleCounts.get(row.title) ?? 0) > 1
                ? `${categoryTitles[row.category]} ${row.title}`
                : row.title,
        haystack: lower([row.haystack, categoryTitles[row.category], row.subcategory]),
    }));
})();

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
