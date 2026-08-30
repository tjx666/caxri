/**
 * Single source of truth for every `settings.jsonc` field: identity, UI metadata, value shape, bounds, and defaults.
 * The zod validation schema (`settings-schema.ts`) and the Renderer's Settings page (rows, table of contents, and
 * search index) are both derived from this table, so adding a setting is one entry here plus, for complex values, one
 * hand-written sub-schema.
 */

import { agentProviderCatalog, agentProviderIds } from '../agent/agents.js';

export const settingCategories = [
    { id: 'general', title: 'General' },
    { id: 'terminal', title: 'Terminal' },
    { id: 'editor', title: 'Editor' },
    { id: 'security', title: 'Security' },
    { id: 'files', title: 'Files' },
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
    {
        kind: 'enum',
        key: 'session.defaultAgent',
        title: 'Default agent for new sessions',
        category: 'general',
        keywords: [...agentProviderIds, 'shell', 'provider'],
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
        kind: 'enum',
        key: 'workbench.newWorktreeBehavior',
        title: 'New worktree behavior',
        description: 'First access to a worktree always requires folder authorization',
        category: 'general',
        keywords: ['git', 'branch', 'checkout'],
        options: [
            { value: 'ask', label: 'Ask' },
            { value: 'continueWhenAuthorized', label: 'Continue when authorized' },
            { value: 'ignore', label: 'Ignore' },
        ],
        default: 'ask',
    },
    {
        kind: 'enum',
        key: 'primarySidebar.autoCollapseProjects',
        title: 'Auto-collapse inactive Projects',
        description: 'Keeps active, working, unread, and manually expanded Projects open',
        category: 'general',
        keywords: ['primarySidebar', 'project', 'collapse', 'inactive', 'idle'],
        options: [
            { value: 'off', label: 'Off' },
            { value: '30m', label: 'After 30 minutes' },
            { value: '2h', label: 'After 2 hours' },
        ],
        default: 'off',
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
        default: 2000,
        display: { unit: 'lines' },
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
        title: 'GPU acceleration',
        description: 'WebGL falls back to DOM rendering without restarting the Terminal',
        category: 'terminal',
        keywords: ['webgl', 'renderer', 'performance'],
        options: [
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
        ],
        default: 'off',
    },
    {
        kind: 'boolean',
        key: 'terminal.osc52ClipboardWrite',
        title: 'Allow OSC 52 clipboard writes',
        description: 'Remote programs may request bounded writes; clipboard reads stay blocked',
        category: 'terminal',
        keywords: ['clipboard', 'escape sequence', 'security'],
        default: false,
    },
    {
        kind: 'string',
        key: 'terminal.wordSeparators',
        title: 'Word separators',
        description:
            'Characters that separate words for double-click selection and fallback file-link detection; explicit line:column links are parsed independently',
        category: 'terminal',
        keywords: ['link', 'path', 'word', 'separator', 'double click', 'selection'],
        nullable: false,
        maxLength: 128,
        // Matches the VS Code `terminal.integrated.wordSeparators` default, including the leading space.
        default: ' ()[]{}\',"`─‘’“”|',
    },
    {
        kind: 'complex',
        key: 'terminal.referenceLinks',
        title: 'Reference links',
        description: 'Open issue markers such as LOBE-123 with a bounded HTTP(S) URL template',
        category: 'terminal',
        keywords: ['link', 'issue', 'linear', 'jira', 'prefix', 'autolink'],
    },
    {
        kind: 'string',
        key: 'terminal.defaultWorkingDirectory',
        title: 'New Terminal working directory',
        description: 'Leave empty to use the Project root',
        category: 'terminal',
        keywords: ['cwd', 'directory', 'path'],
        nullable: true,
        maxLength: 16_384,
        default: null,
        placeholder: 'Project root',
    },
    {
        kind: 'string',
        key: 'editor.fontFamily',
        title: 'Font family',
        description: 'Code and diff editor font; leave empty for the Monaco default',
        category: 'editor',
        keywords: ['font', 'typeface', 'monospace', 'monaco', 'diff'],
        nullable: true,
        maxLength: 1024,
        default: null,
        placeholder: 'Monaco default',
    },
    {
        kind: 'boolean',
        key: 'git.fetchGitHubAvatars',
        title: 'Fetch commit avatars from GitHub',
        description:
            'Look up commit author avatars on GitHub; author emails are sent to github.com. Only used in repositories with a GitHub remote.',
        category: 'security',
        keywords: ['avatar', 'github', 'commit', 'author', 'privacy', 'email'],
        default: true,
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
        key: 'files.exclude',
        title: 'Excluded files',
        description: 'Glob patterns hidden from the file tree',
        category: 'files',
        keywords: ['hide', 'ignore', 'glob', 'pattern', 'tree'],
    },
    {
        kind: 'integer',
        key: 'files.maxFileBytes',
        title: 'Maximum editable file size',
        description: 'Larger files open read-only to keep the editor responsive',
        category: 'files',
        keywords: ['limit', 'editor', 'megabytes'],
        min: 1024,
        max: MAX_CONFIGURABLE_FILE_BYTES,
        default: 2 * MEBIBYTE,
        display: { unit: 'MB', scale: MEBIBYTE, step: 0.5 },
    },
    {
        kind: 'complex',
        key: 'agents.providers',
        title: 'Agent providers',
        description:
            'Launch commands, lifecycle hooks, peer messaging, and output recovery per Agent provider',
        category: 'agents',
        keywords: [
            ...agentProviderIds,
            'executable',
            'launch',
            'hooks',
            'messaging',
            'network',
            'recovery',
            'timeout',
        ],
    },
    {
        kind: 'boolean',
        key: 'agents.notifications.enabled',
        title: 'System notifications',
        description:
            'Notify when a background Agent needs attention; provider lifecycle hooks must also be enabled',
        category: 'agents',
        keywords: ['notification', 'alert', 'background', 'attention', 'waiting', 'completed'],
        default: true,
    },
    {
        kind: 'integer',
        key: 'agents.notifications.completionThresholdSeconds',
        title: 'Completed turn threshold',
        description: 'Only notify for completed Agent turns that ran for at least this long',
        category: 'agents',
        keywords: ['notification', 'duration', 'minimum', 'completed', 'turn'],
        min: 0,
        max: 3_600,
        default: 60,
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
