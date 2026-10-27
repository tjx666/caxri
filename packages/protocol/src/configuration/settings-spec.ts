/**
 * Single source of truth for every `settings.jsonc` field: identity, UI metadata, value shape, bounds, and defaults.
 * The zod validation schema (`settings-schema.ts`) and the Renderer's Settings page (rows, table of contents, and
 * search index) are both derived from this table, so adding a setting is one entry here (or in a category file such as
 * `editor-settings-spec.ts`) plus, for complex values, one hand-written sub-schema.
 */

import { agentProviderCatalog, agentProviderIds } from '../agent/agents.js';
import { agentChatSettingsSpec } from './agent-chat-settings-spec.js';
import { agentSettingsSpec } from './agent-settings-spec.js';
import { agentSuspensionSettingsSpec } from './agent-suspension-settings-spec.js';
import { editorSettingsSpec } from './editor-settings-spec.js';
import { environmentMonitorSettingsSpec } from './environment-monitor-settings-spec.js';
import { languageSettingsSpec } from './language-settings-spec.js';
import { primarySidebarSettingsSpec } from './primary-sidebar-settings-spec.js';

export const settingCategories = [
    { id: 'general', title: 'General' },
    { id: 'chat', title: 'Chat' },
    { id: 'notifications', title: 'Notifications' },
    { id: 'mobile', title: 'Mobile' },
    { id: 'terminal', title: 'Terminal' },
    { id: 'editor', title: 'Editor' },
    { id: 'security', title: 'Security' },
    { id: 'files', title: 'Files' },
    { id: 'projectStatus', title: 'Project Status' },
    { id: 'agents', title: 'Agents' },
] as const;

export type SettingCategoryId = (typeof settingCategories)[number]['id'];

interface SettingSpecBase {
    /**
     * Flat dot-namespaced key exactly as written in `settings.jsonc`.
     */
    key: string;
    title: string;
    description?: string;
    category: SettingCategoryId;
    /**
     * Extra search-only terms that never render (synonyms, related jargon).
     */
    keywords?: readonly string[];
}

export interface BooleanSettingSpec extends SettingSpecBase {
    kind: 'boolean';
    default: boolean;
}

export interface IntegerSettingSpec extends SettingSpecBase {
    kind: 'integer';
    min: number;
    max: number;
    default: number;
    /**
     * Optional UI presentation: the stored integer divided by `scale` is shown with `unit` (e.g. bytes stored,
     * mebibytes edited). Validation always applies to the stored value.
     */
    display?: { unit: string; scale?: number; step?: number };
}

export interface EnumSettingSpec extends SettingSpecBase {
    kind: 'enum';
    options: ReadonlyArray<{ value: string; label: string }>;
    /**
     * Label the UI shows for the `null` choice when the setting is nullable.
     */
    nullLabel?: string;
    default: string | null;
}

export interface StringSettingSpec extends SettingSpecBase {
    kind: 'string';
    /**
     * `null` models "unset, fall back to runtime behavior"; the empty string is never stored.
     */
    nullable: boolean;
    maxLength: number;
    default: string | null;
    placeholder?: string;
    /**
     * Prose that spans lines, edited in a resizable text area instead of a one-line field.
     */
    multiline?: boolean;
    /**
     * Text a nullable setting stands for while it is `null`: the control shows it, and editing the field back to it
     * stores `null` again. `settings.jsonc` holds every default, so a preset stored as the default itself would freeze
     * in each profile at its first write and never follow a newer Caxri; `null` keeps tracking the installed preset.
     */
    preset?: string;
}

/**
 * A field whose value shape is too rich for a generic control (records, arrays with normalization). Its sub-schema
 * stays hand-written in `settings-schema.ts` and its editor is a dedicated component; this entry still owns the shared
 * metadata so search and navigation see it.
 */
export interface ComplexSettingSpec extends SettingSpecBase {
    kind: 'complex';
}

export type SettingSpec =
    | BooleanSettingSpec
    | IntegerSettingSpec
    | EnumSettingSpec
    | StringSettingSpec
    | ComplexSettingSpec;

const MEBIBYTE = 1024 * 1024;

/**
 * Hard ceiling for `files.maxFileBytes`; editors above this size refuse to open regardless.
 */
export const MAX_CONFIGURABLE_FILE_BYTES = 16 * MEBIBYTE;

export const settingsSpec = [
    ...languageSettingsSpec,
    ...environmentMonitorSettingsSpec,
    {
        kind: 'enum',
        key: 'session.defaultAgent',
        title: 'Default Agent',
        description:
            'Starts new Sessions and new Terminals with this Agent. Ask each time opens the list instead, and the New Terminal button always offers the other Agents.',
        category: 'general',
        keywords: [...agentProviderIds, 'shell', 'provider', 'terminal', 'session'],
        options: [
            ...agentProviderIds.map((provider) => ({
                value: provider,
                label: agentProviderCatalog[provider].displayName,
            })),
            { value: 'shell', label: 'Shell' },
        ],
        nullLabel: 'Ask each time',
        default: null,
    },
    {
        kind: 'boolean',
        key: 'session.openAgentsInChat',
        title: 'Open Agents in Chat',
        description:
            'Starts new Agents as a Chat instead of a Terminal. Shell always opens in a Terminal. The New Session and New Terminal menus toggle this too.',
        category: 'general',
        keywords: ['chat', 'surface', 'terminal', 'claude', 'codex', 'grok', 'conversation', 'tui'],
        default: true,
    },
    ...agentChatSettingsSpec,
    {
        kind: 'enum',
        key: 'workbench.newWorktreeBehavior',
        title: 'New worktree behavior',
        description:
            'Choose whether to follow detected worktrees. Continue automatically authorizes new worktree folders without asking.',
        category: 'general',
        keywords: ['git', 'branch', 'checkout'],
        options: [
            { value: 'ask', label: 'Ask' },
            { value: 'continueWhenAuthorized', label: 'Continue when authorized' },
            { value: 'continueAutomatically', label: 'Continue automatically' },
            { value: 'ignore', label: 'Ignore' },
        ],
        default: 'ask',
    },
    {
        kind: 'boolean',
        key: 'workbench.confirmWorktreeAuthorization',
        title: 'Confirm worktree authorization',
        description:
            'Ask before authorizing a worktree picked from the status bar. Turn off to authorize and switch right away.',
        category: 'general',
        keywords: ['git', 'branch', 'worktree', 'authorize', 'confirm', 'workbench root'],
        default: true,
    },
    ...primarySidebarSettingsSpec,
    {
        kind: 'boolean',
        key: 'statusBar.usage.showFiveHourLimit',
        title: 'Show 5-hour limit in the status bar',
        description:
            'Adds the 5-hour plan limit to the Agent usage chip beside the weekly limit. Its hover card always lists every limit.',
        category: 'general',
        keywords: ['statusBar', 'usage', 'limit', 'quota', '5h', 'five hour', 'rate limit', 'plan'],
        default: false,
    },
    {
        kind: 'integer',
        key: 'window.zoomLevel',
        title: 'Zoom level',
        description:
            'Scales the whole interface. 0 is the original size; each step up or down zooms by 20%. View › Zoom In, Zoom Out, and Reset Zoom change it too.',
        category: 'general',
        keywords: ['zoom', 'scale', 'size', 'magnify', 'ui', 'interface'],
        min: -5,
        max: 8,
        default: 0,
    },
    {
        kind: 'string',
        key: 'workbench.fontFamily',
        title: 'Font family',
        description: 'Workbench UI font; leave empty for the system font',
        category: 'general',
        keywords: ['font', 'typeface', 'ui', 'workbench'],
        nullable: true,
        maxLength: 1024,
        default: null,
        placeholder: 'System font',
    },
    {
        kind: 'string',
        key: 'workbench.externalEditor',
        title: 'External editor',
        description: 'Command used by “Open Project in External Editor” (e.g. code, cursor, subl)',
        category: 'general',
        keywords: ['editor', 'vscode', 'cursor', 'ide', 'open', 'reveal'],
        nullable: true,
        maxLength: 1024,
        default: 'code',
        placeholder: 'code',
    },
    {
        kind: 'string',
        key: 'updates.skippedVersion',
        title: 'Skipped update version',
        /**
         * The one durable consequence of `Skip this version`, surfaced where the user can undo it. A persisted state
         * with no visible home is a trap: without this row, someone who skipped a release once would have no way to
         * learn why Caxri stopped offering it, or to ask for it again. Rendered read-only (setting-row.tsx special-
         * cases this key) rather than through the generic free-text control every other `string` setting gets, since
         * this is app-written state to undo, not a value worth typing by hand; "Reset" replaces the old "Clear the
         * field" instruction now that there is no field.
         */
        description:
            'Caxri stops offering this release until a newer one appears. Reset to be offered it again.',
        category: 'general',
        keywords: ['update', 'upgrade', 'skip', 'skipped', 'version', 'release', 'ignore'],
        nullable: true,
        maxLength: 64,
        default: null,
    },
    {
        kind: 'string',
        key: 'terminal.fontFamily',
        title: 'Font family',
        description: 'Used before the bundled JetBrains Mono fallback stack',
        category: 'terminal',
        keywords: ['font', 'typeface', 'monospace'],
        nullable: true,
        maxLength: 1024,
        default: null,
        placeholder: 'Caxri JetBrains Mono',
    },
    {
        kind: 'integer',
        key: 'terminal.fontSize',
        title: 'Font size',
        category: 'terminal',
        keywords: ['text', 'zoom'],
        min: 9,
        max: 32,
        default: 13,
        display: { unit: 'px' },
    },
    {
        kind: 'integer',
        key: 'terminal.scrollback',
        title: 'Scrollback lines',
        description: 'Lines kept in the Terminal buffer beyond the visible viewport',
        category: 'terminal',
        keywords: ['history', 'buffer'],
        min: 100,
        max: 10_000,
        default: 8000,
        display: { unit: 'lines' },
    },
    {
        kind: 'integer',
        key: 'terminal.longPasteThreshold',
        title: 'Long paste threshold',
        description:
            'Longer text pasted into a running Agent is saved to a local file and replaced with its path, so the Agent reads it instead of receiving it through the Terminal. The maximum keeps ordinary pastes native; larger text is still saved to a file.',
        category: 'terminal',
        keywords: ['clipboard', 'paste', 'context', 'tokens'],
        min: 1,
        /**
         * Keep the threshold within the native Terminal paste budget. It is not an off switch: larger text must still
         * take the saved-file path. The value is inlined to avoid a protocol configuration import cycle.
         */
        max: 1_048_576,
        default: 2_048,
        display: { unit: 'characters', step: 256 },
    },
    {
        kind: 'boolean',
        key: 'terminal.copyOnSelect',
        title: 'Copy on select',
        description: 'Automatically copy Terminal selections to the clipboard',
        category: 'terminal',
        keywords: ['clipboard'],
        default: true,
    },
    {
        kind: 'enum',
        key: 'terminal.gpuAcceleration',
        title: 'Terminal hardware acceleration',
        /**
         * Scoped to only the Terminal's own WebGL renderer, unlike Hardware acceleration below, and it depends on that
         * broader setting: with Hardware acceleration off, the GPU is unavailable to the whole app, so this setting has
         * nothing to accelerate regardless of its own value (verified in `terminal-renderer-status.ts`'s
         * `isBootDisabled` case).
         */
        description:
            'Draws the Terminal with the graphics card; turn off to use software rendering. Takes effect ' +
            'without restarting the Terminal. Has no effect while Hardware acceleration is off, since that ' +
            'already draws every Terminal in software.',
        category: 'terminal',
        keywords: ['webgl', 'renderer', 'performance', 'hardware acceleration'],
        options: [
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
        ],
        default: 'on',
    },
    ...agentSuspensionSettingsSpec,
    {
        kind: 'boolean',
        key: 'terminal.osc52ClipboardWrite',
        title: 'Let programs in the Terminal copy to your clipboard',
        description:
            'Programs such as tmux or a remote shell may copy text to your clipboard through OSC 52; they can never ' +
            'read it',
        category: 'terminal',
        keywords: ['clipboard', 'escape sequence', 'security'],
        default: true,
    },
    {
        kind: 'string',
        key: 'terminal.wordSeparators',
        title: 'Word separators',
        description:
            'Characters that end a word when you double-click to select, and when Caxri looks for file names to link. Links such as file.ts:12 are found either way',
        category: 'terminal',
        keywords: ['link', 'path', 'word', 'separator', 'double click', 'selection'],
        nullable: false,
        maxLength: 128,
        // Extend the VS Code baseline so double-click selection also stops at Chinese punctuation.
        default: ' ()[]{}\',"`─‘’“”|，。；：！？、（）【】「」『』《》',
    },
    {
        kind: 'complex',
        key: 'terminal.referenceLinks',
        title: 'Reference links',
        description: 'Turn issue markers such as TASK-123 into links, using a web address template',
        category: 'terminal',
        keywords: ['link', 'issue', 'linear', 'jira', 'prefix', 'autolink'],
    },
    {
        kind: 'string',
        key: 'terminal.defaultWorkingDirectory',
        title: 'New Terminal working directory',
        description: 'Leave empty to use the current Workbench Root',
        category: 'terminal',
        keywords: ['cwd', 'directory', 'path'],
        nullable: true,
        maxLength: 16_384,
        default: null,
        placeholder: 'Current Workbench Root',
    },
    ...editorSettingsSpec,
    {
        kind: 'boolean',
        key: 'git.fetchGitHubAvatars',
        title: 'Fetch commit avatars from GitHub',
        description:
            'Look up commit author avatars on GitHub; author emails are sent to github.com. Only used in repositories with a GitHub remote.',
        category: 'security',
        keywords: ['avatar', 'github', 'commit', 'author', 'privacy', 'email'],
        default: false,
    },
    {
        kind: 'complex',
        key: 'security.trustedDomains',
        title: 'Trusted domains',
        description: 'Links on these domains open without a confirmation prompt',
        category: 'security',
        keywords: ['url', 'link', 'origin', 'allowlist'],
    },
    {
        kind: 'complex',
        key: 'security.trustedFolders',
        title: 'Trusted folders',
        description:
            'Terminal file links under these folders open in the editor without a confirmation prompt; saving writes back to the file',
        category: 'security',
        keywords: ['path', 'folder', 'directory', 'link', 'terminal', 'allowlist', 'external'],
    },
    {
        kind: 'complex',
        key: 'files.exclude',
        title: 'Excluded files',
        description: 'Glob patterns hidden from the file tree',
        category: 'files',
        keywords: ['hide', 'ignore', 'glob', 'pattern', 'tree'],
    },
    {
        kind: 'complex',
        key: 'git.diffExclude',
        title: 'Excluded Git diff files',
        description:
            'Hide matching repository-relative paths from Git change lists and Open All Changes. Tests and translation catalogs are excluded by default. Use the Source Control eye button to show them temporarily. Supports *, **, and ?; this does not change Git tracking.',
        category: 'files',
        keywords: [
            'git',
            'diff',
            'test',
            'spec',
            'locales',
            'i18n',
            'hide',
            'ignore',
            'glob',
            'source control',
        ],
    },
    {
        kind: 'integer',
        key: 'files.maxFileBytes',
        title: 'Maximum editable file size',
        /**
         * The Server refuses to read a larger file at all (`DocumentService` throws `CAPACITY`), and Project search
         * skips it, so the description must not promise a read-only view.
         */
        description:
            "Larger files can't be opened in the editor and are skipped by search. Use Open with Default App for them.",
        category: 'files',
        keywords: ['limit', 'editor', 'megabytes'],
        min: 1024,
        max: MAX_CONFIGURABLE_FILE_BYTES,
        default: 2 * MEBIBYTE,
        display: { unit: 'MB', scale: MEBIBYTE, step: 0.5 },
    },
    {
        kind: 'complex',
        key: 'projectStatus.ignoredChecks',
        title: 'Ignored checks',
        description:
            'Checks left out of the CI rollup, the sidebar badge, and failure notifications',
        category: 'projectStatus',
        keywords: [
            'ci',
            'check',
            'github',
            'workflow',
            'job',
            'ignore',
            'hide',
            'glob',
            'pattern',
            'status',
        ],
    },
    {
        kind: 'boolean',
        key: 'projectStatus.notifyAgentOnMerge',
        title: 'Tell the Agent when its pull request is merged',
        description:
            'Sends “Pull request <link> has been merged.” to the Session’s Agent as a new message once, however the merge happened (Project Status, GitHub, or someone else). Not sent when the Agent merged it during its own turn.',
        category: 'projectStatus',
        keywords: ['merge', 'pull request', 'pr', 'agent', 'message', 'notify', 'github'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'projectStatus.autoArchiveOnPullRequestSettled',
        title: 'Auto-archive after pull request merge or close',
        description:
            'Archives a Session once its pull request is merged or closed and its Agent is idle. A running Agent, or one with a background shell or subagent still running, is never archived, and nothing is deleted: find the Session under Archived Sessions to restore it.',
        category: 'projectStatus',
        keywords: ['archive', 'merge', 'close', 'pull request', 'pr', 'session', 'automatic'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'projectStatus.notifications.enabled',
        title: 'Delivery failure notifications',
        description: 'Notify when a CI check or a Vercel deployment starts failing',
        category: 'notifications',
        keywords: [
            'notification',
            'alert',
            'ci',
            'vercel',
            'deployment',
            'failure',
            'build',
            'broken',
        ],
        default: true,
    },
    ...agentSettingsSpec,
    {
        kind: 'boolean',
        key: 'agents.notifications.enabled',
        title: 'System notifications',
        description:
            'Notify when a background Agent needs attention. Agents running in Terminals also need their provider lifecycle hooks enabled; Chats do not',
        category: 'notifications',
        keywords: ['notification', 'alert', 'background', 'attention', 'waiting', 'completed'],
        default: true,
    },
    {
        kind: 'integer',
        key: 'agents.notifications.completionThresholdSeconds',
        title: 'Completed turn threshold',
        description: 'Only notify for completed Agent turns that ran for at least this long',
        category: 'notifications',
        keywords: ['notification', 'duration', 'minimum', 'completed', 'turn'],
        min: 0,
        max: 3_600,
        default: 15,
        display: { unit: 'seconds' },
    },
] as const satisfies readonly SettingSpec[];

export type SettingKey = (typeof settingsSpec)[number]['key'];

/**
 * Convenience lookup keyed by setting key; the array above stays the display-order authority.
 */
export const settingsSpecByKey = Object.fromEntries(
    settingsSpec.map((spec) => [spec.key, spec]),
) as { readonly [K in SettingKey]: Extract<(typeof settingsSpec)[number], { key: K }> };
