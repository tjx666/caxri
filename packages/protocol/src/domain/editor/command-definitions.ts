import type { CommandDefinition } from '../command-catalog.js';

/**
 * Commands of the active text editor, listed after the tab navigation commands in the command catalog.
 */
export const editorCommandDefinitions: CommandDefinition[] = [
    {
        id: 'editor.save',
        title: 'Save File',
        category: 'Editor',
        description: 'Save the active file',
    },
    {
        id: 'editor.newUntitledFile',
        title: 'New Untitled Text File',
        category: 'Editor',
        description:
            'Open an empty untitled editor whose language is detected from what you type; it asks to save before closing',
        keywords: ['new file', 'scratch', 'temporary editor', 'untitled'],
    },
    {
        id: 'editor.sendReferenceToTerminal',
        title: 'Send File Reference to Terminal or Chat',
        category: 'Editor',
        description:
            'Type the active file path and cursor line (`@path#L12`) into the most recently opened Terminal or Agent Chat message',
        keywords: ['mention', 'at', 'line', 'path', 'agent'],
    },
    {
        id: 'editor.addReviewComment',
        title: 'Add Review Comment',
        category: 'Editor',
        description: 'Annotate the selected lines in a Git diff',
        keywords: ['diff', 'comment', 'review', 'agent'],
    },
    {
        id: 'editor.openPreview',
        title: 'Open Preview',
        category: 'Editor',
        description: 'Show the active Markdown or SVG file as a rendered preview',
        keywords: ['markdown', 'md', 'render', 'svg', 'image', 'mermaid'],
    },
    {
        id: 'editor.openPreviewToSide',
        title: 'Open Preview to the Side',
        category: 'Editor',
        description: 'Show the active Markdown or SVG file as a rendered preview beside its source',
        keywords: ['markdown', 'md', 'render', 'svg', 'image', 'mermaid', 'split'],
    },
    {
        id: 'editor.openImportLink',
        title: 'Open Import Link',
        category: 'Editor',
        description: 'Open the file named by the import specifier under the editor cursor',
        keywords: ['definition', 'follow', 'go to', 'module', 'specifier'],
    },
];
