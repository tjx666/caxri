/**
 * Single source of truth for every `settings.jsonc` field: identity, UI metadata, value shape, bounds, and defaults.
 * The zod validation schema (`settings-schema.ts`) and the Renderer's Settings page (rows, table of contents, and
 * search index) are both derived from this table, so adding a setting is one entry here plus, for complex values, one
 * hand-written sub-schema.
 */

import { agentProviderCatalog, agentProviderIds } from '../agent/agents.js';

export const settingCategories = [
    { id: 'general', title: 'General' },
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
        kind: 'boolean',
        key: 'notifications.worktreeFallback',
        title: 'Worktree fallback reminders',
        description:
            'Show a popup when an unavailable worktree returns to its Project. Turn on to restore muted reminders. Applies to all Projects; recent events remain in Notifications.',
        category: 'notifications',
        keywords: ['mute', 'unmute', 'silent', 'reminder', 'notification'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'notifications.agentRecovery',
        title: 'Automatic Agent recovery reminders',
        description:
            'Show a popup after automatic Agent recovery. Turn on to restore muted reminders. Applies to all Projects; failures always appear.',
        category: 'notifications',
        keywords: ['mute', 'unmute', 'silent', 'reminder', 'notification'],
        default: true,
    },
    {
        kind: 'enum',
        key: 'session.defaultAgent',
        title: 'Default agent',
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
        default: '30m',
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
        title: 'GPU acceleration',
        /**
         * Scoped to only the Terminal's own WebGL renderer, unlike Hardware acceleration below — and it depends on that
         * broader setting: with Hardware acceleration off, the GPU is unavailable to the whole app, so this setting has
         * nothing to accelerate regardless of its own value (verified in `terminal-renderer-status.ts`'s
         * `isBootDisabled` case).
         */
        description:
            "Controls only the Terminal's WebGL rendering; falls back to DOM without restarting the " +
            'Terminal. Has no effect while Hardware acceleration is off, since that already turns the ' +
            'GPU off for every Terminal.',
        category: 'terminal',
        keywords: ['webgl', 'renderer', 'performance', 'hardware acceleration'],
        options: [
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
        ],
        default: 'on',
    },
    {
        kind: 'boolean',
        key: 'terminal.suspendUntouchedAgents',
        title: 'Suspend untouched Agents',
        description:
            'Stops an Agent CLI that received no input before you switched away; it resumes on return',
        category: 'terminal',
        keywords: ['agent', 'suspend', 'idle', 'background', 'memory', 'resume'],
        default: true,
    },
    {
        kind: 'enum',
        key: 'terminal.suspendIdleAgents',
        title: 'Suspend idle background Agents',
        description:
            'Stops Agent CLIs idle at their prompt in unselected Sessions; they resume on return',
        category: 'terminal',
        keywords: ['agent', 'suspend', 'idle', 'background', 'memory', 'resume'],
        options: [
            { value: 'off', label: 'Off' },
            { value: '30m', label: 'After 30 minutes' },
            { value: '2h', label: 'After 2 hours' },
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
        default: true,
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
        // Extend the VS Code baseline so double-click selection also stops at Chinese punctuation.
        default: ' ()[]{}\',"`─‘’“”|，。；：！？、（）【】「」『』《》',
    },
    {
        kind: 'complex',
        key: 'terminal.referenceLinks',
        title: 'Reference links',
        description: 'Open issue markers such as TASK-123 with a bounded HTTP(S) URL template',
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
    {
        kind: 'string',
        key: 'editor.fontFamily',
        title: 'Font family',
        description: 'Code and diff editor font; leave empty for the Monaco default',
        category: 'editor',
        keywords: ['font', 'typeface', 'monospace', 'monaco', 'diff'],
        nullable: true,
        maxLength: 1024,
        default: "'Fira Code', 'JetBrains Mono', 'Caxri JetBrains Mono', monospace",
        placeholder: 'Monaco default',
    },
    {
        kind: 'integer',
        key: 'editor.fontSize',
        title: 'Font size',
        description: 'Code and diff editor font size',
        category: 'editor',
        keywords: ['font', 'size', 'zoom', 'monaco', 'diff'],
        min: 6,
        max: 48,
        default: 13,
        display: { unit: 'px' },
    },
    {
        kind: 'enum',
        key: 'editor.wordWrap',
        title: 'Word wrap',
        description: 'Wrap long lines instead of scrolling horizontally',
        category: 'editor',
        keywords: ['wrap', 'line', 'long', 'horizontal', 'scroll'],
        options: [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'At the viewport edge' },
            { value: 'bounded', label: 'At 80 columns or the viewport edge' },
        ],
        default: 'off',
    },
    {
        kind: 'string',
        key: 'editor.wordSeparators',
        title: 'Word separators',
        description:
            'Characters that end a word for double-click selection and word-wise cursor movement',
        category: 'editor',
        keywords: ['word', 'separator', 'double click', 'selection', 'punctuation'],
        nullable: false,
        maxLength: 256,
        /*
         * The VS Code baseline extended with Chinese punctuation, so double-clicking an identifier in Chinese prose
         * stops at the full-width comma instead of selecting the rest of the sentence.
         */
        default: '`~!@#%^&*()-=+[{]}\\|;:：\'",.<>/?，。‘’“”；（）【】{}《》「」',
    },
    {
        kind: 'enum',
        key: 'editor.autoClosingDelete',
        title: 'Delete both halves of a pair',
        description:
            'Deleting one half of an empty bracket or quote pair removes the other. Only ever applies to an adjacent empty pair.',
        category: 'editor',
        keywords: ['bracket', 'quote', 'pair', 'delete', 'backspace', 'auto close'],
        options: [
            { value: 'always', label: 'Always' },
            { value: 'auto', label: 'Only pairs this editor inserted' },
            { value: 'never', label: 'Never' },
        ],
        /*
         * Monaco and VS Code default to `auto`, which makes the behavior depend on invisible history: the same `()`
         * deletes as a pair or as one character depending on who typed it. The pair already in the file is the one a
         * user is most likely editing.
         */
        default: 'always',
    },
    {
        kind: 'boolean',
        key: 'editor.linkedEditing',
        title: 'Linked editing',
        description: 'Renaming an HTML or JSX tag renames its matching tag as you type',
        category: 'editor',
        keywords: ['rename', 'tag', 'html', 'jsx', 'mirror', 'linked'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'editor.stickyScroll.enabled',
        title: 'Sticky scroll',
        description: 'Pin the enclosing scopes of the top line to the top of the editor',
        category: 'editor',
        keywords: ['sticky', 'scroll', 'scope', 'header', 'context'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'editor.stickyTabStops',
        title: 'Sticky tab stops',
        description: 'Move the cursor across space indentation one indent level at a time',
        category: 'editor',
        keywords: ['tab', 'indent', 'stop', 'cursor', 'space'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'editor.bracketPairColorization.enabled',
        title: 'Bracket pair colorization',
        description: 'Color matching brackets by nesting depth',
        category: 'editor',
        keywords: ['bracket', 'pair', 'color', 'rainbow', 'nesting'],
        default: true,
    },
    {
        kind: 'enum',
        key: 'editor.guides.bracketPairs',
        title: 'Bracket pair guides',
        description: 'Vertical guides connecting a bracket pair',
        category: 'editor',
        keywords: ['bracket', 'guide', 'indent', 'vertical', 'line'],
        options: [
            { value: 'off', label: 'Off' },
            { value: 'active', label: 'Only the active pair' },
            { value: 'all', label: 'All pairs' },
        ],
        default: 'active',
    },
    {
        kind: 'enum',
        key: 'editor.renderWhitespace',
        title: 'Render whitespace',
        description: 'Show space and tab characters',
        category: 'editor',
        keywords: ['whitespace', 'space', 'tab', 'invisible', 'render'],
        options: [
            { value: 'none', label: 'Never' },
            { value: 'boundary', label: 'Except single spaces between words' },
            { value: 'selection', label: 'Inside the selection' },
            { value: 'trailing', label: 'Trailing only' },
            { value: 'all', label: 'Always' },
        ],
        default: 'selection',
    },
    {
        kind: 'enum',
        key: 'editor.cursorBlinking',
        title: 'Cursor blinking',
        description: 'How the caret animates between visible and hidden',
        category: 'editor',
        keywords: ['cursor', 'caret', 'blink', 'animation'],
        options: [
            { value: 'blink', label: 'Blink' },
            { value: 'smooth', label: 'Smooth' },
            { value: 'phase', label: 'Phase' },
            { value: 'expand', label: 'Expand' },
            { value: 'solid', label: 'Solid' },
        ],
        default: 'smooth',
    },
    {
        kind: 'enum',
        key: 'editor.cursorSmoothCaretAnimation',
        title: 'Smooth caret animation',
        description: 'Animate the caret as it moves between positions',
        category: 'editor',
        keywords: ['cursor', 'caret', 'smooth', 'animation', 'move'],
        options: [
            { value: 'off', label: 'Off' },
            { value: 'explicit', label: 'Only for explicit moves' },
            { value: 'on', label: 'Always' },
        ],
        default: 'on',
    },
    {
        kind: 'boolean',
        key: 'editor.smoothScrolling',
        title: 'Smooth scrolling',
        description: 'Animate the editor viewport as it scrolls',
        category: 'editor',
        keywords: ['scroll', 'smooth', 'animation'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'editor.dragAndDrop',
        title: 'Drag and drop selected text',
        description: 'Move a selection by dragging it inside the editor',
        category: 'editor',
        keywords: ['drag', 'drop', 'move', 'selection'],
        default: false,
    },
    {
        kind: 'boolean',
        key: 'editor.minimap.enabled',
        title: 'Minimap',
        description: 'Show the code overview strip along the right edge',
        category: 'editor',
        keywords: ['minimap', 'overview', 'preview', 'scrollbar'],
        default: false,
    },
    {
        kind: 'boolean',
        key: 'editor.unfoldOnClickAfterEndOfLine',
        title: 'Unfold on click after end of line',
        description: 'Clicking the empty space after a folded line unfolds it',
        category: 'editor',
        keywords: ['fold', 'folding', 'collapse', 'expand', 'unfold', 'click'],
        default: true,
    },
    {
        kind: 'integer',
        key: 'editor.foldOnOpenLineThreshold',
        title: 'Fold on open above',
        description:
            'Collapse every foldable region the first time a file longer than this opens, the same as Fold All. Set to 0 to never fold on open.',
        category: 'editor',
        keywords: ['fold', 'folding', 'collapse', 'outline', 'overview', 'long', 'large', 'open'],
        min: 0,
        /**
         * Out of reach of any source file a person reads in the Editor, so raising the field to its maximum also
         * behaves as an off switch. `0` remains the explicit one.
         */
        max: 1_000_000,
        default: 1_000,
        display: { unit: 'lines', step: 100 },
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
        key: 'security.trustedFolders',
        title: 'Trusted folders',
        description:
            'Terminal file links under these folders open read-only without a confirmation prompt',
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
        kind: 'complex',
        key: 'agents.delegation',
        title: 'Agent delegation',
        description: 'Named delegation presets, caller bindings and maximum delegation depth',
        category: 'agents',
        keywords: ['presets', 'delegation', 'model', 'effort', 'depth', 'caller'],
    },
    {
        kind: 'boolean',
        key: 'agents.notifications.enabled',
        title: 'System notifications',
        description:
            'Notify when a background Agent needs attention; provider lifecycle hooks must also be enabled',
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
