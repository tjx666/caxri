/**
 * One approved file in the native `title` inventory.
 */
interface ApprovedNativeTitle {
    /**
     * Number of native `title` sites approved in the file; a new one beyond it fails `caxri/native-title`.
     */
    count: number;
    /**
     * Why a keyboard user loses nothing when this title never shows.
     */
    reason: string;
}

/**
 * Approved native `title` uses in the Renderer, keyed by repo-relative path. A native `title` shows only on mouse
 * hover, so unique or truncated content (a full path, a command ID, an exit status) must not live in one: move it to
 * the shared `Tooltip`, whose trigger opens on keyboard focus (`FOCUSABLE_TOOLTIP_TRIGGER_CLASS` for a text trigger),
 * or to visible text. An entry belongs here only when the title repeats information that is reachable another way, or
 * when the element is generated DOM outside React that no keyboard flow can focus. Entries should only ever be
 * removed.
 */
export const approvedNativeTitles: Readonly<Partial<Record<string, ApprovedNativeTitle>>> = {
    'apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-extensions.ts':
        {
            count: 1,
            reason: 'CodeMirror widget DOM outside React; the path is the editor text a keyboard cursor already reads.',
        },
    'apps/desktop/src/renderer/src/features/agent-chat/composer-input/chips/agent-chat-long-paste-chips.ts':
        {
            count: 1,
            reason: 'CodeMirror widget DOM outside React; the size detail is also the chip aria-label a screen reader announces.',
        },
    'apps/desktop/src/renderer/src/features/agent-chat/composer-input/chips/agent-chat-session-chips.ts':
        {
            count: 1,
            reason: 'CodeMirror widget DOM outside React; the Session title is also the chip aria-label a screen reader announces.',
        },
    'apps/desktop/src/renderer/src/features/preview/markdown-code-blocks.ts': {
        count: 3,
        reason: 'Generated copy button whose title repeats its aria-label.',
    },
    'apps/desktop/src/renderer/src/features/project-search/project-search-results.tsx': {
        count: 3,
        reason: 'Active-descendant results: focus stays in the query input, and the path is visible in the group header.',
    },
    'apps/desktop/src/renderer/src/features/terminal/terminal-command-tracker.ts': {
        count: 1,
        reason: 'Pointer-only xterm gutter glyph; keyboard command navigation announces the same status (navigatedCommandStatus).',
    },
    'apps/desktop/src/renderer/src/features/view-containers/resource-explorer/file-tree.tsx': {
        count: 1,
        reason: 'aria-hidden sticky duplicate of a real tree row, which carries the shared Tooltip.',
    },
    'apps/desktop/src/renderer/src/features/view-containers/source-control/source-control-history-hover-card.tsx':
        {
            count: 1,
            reason: 'Truncated copy of the timestamp already printed in the same line.',
        },
    'apps/desktop/src/renderer/src/features/view-containers/source-control/source-control-history.tsx':
        {
            count: 1,
            reason: 'Exact timestamp that the focusable row hover card shows in full.',
        },
    'apps/desktop/src/renderer/src/features/workbench/terminal-pane-tab.tsx': {
        count: 1,
        reason: 'Progress badge whose title equals its aria-label text.',
    },
};
