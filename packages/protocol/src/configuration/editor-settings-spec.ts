import type { SettingSpec } from './settings-spec.js';

/**
 * The Editor category's settings, kept beside the main catalog so `settingsSpec` stays within the source-size ratchet.
 * `settingsSpec` spreads them in place, so their order on the Settings page is unchanged.
 */
export const editorSettingsSpec = [
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
            'Collapse every block of a file longer than this the first time it opens; JSON keeps its top-level keys visible. Unfold All (⌘K ⌘J) expands it again. Set to 0 to never fold on open.',
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
] as const satisfies readonly SettingSpec[];
