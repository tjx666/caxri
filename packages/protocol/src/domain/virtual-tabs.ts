import { isAgentStatusTabPath } from './agent-status-tab.js';
import { isAgentTaskTabPath } from './agent-task-tab.js';
import { isAgentTranscriptTabPath } from './agent-transcript.js';
import { isAgentTurnReviewTabPath } from './agent-turn-review-tab.js';
import { isExternalEditorTabPath } from './external-editor-tab.js';
import { isFilePreviewTabPath } from './file-preview.js';
import { isGitDiffTabPath } from './git-diff.js';
import { isSettingsTabPath } from './settings-tab.js';
import { isUsageTabPath } from './usage-tab.js';

/**
 * Editor tab paths that name a virtual surface instead of a Project file. Virtual tabs are never read or written
 * through `files.*` and keep their encoded path across file renames. Save and dirty-close confirmation skip them,
 * except an external document, which saves through Main's `externalDocument.write` instead. Every new virtual tab
 * scheme must be added here so all of those guards stay in one place.
 */
export function isVirtualEditorTabPath(path: string): boolean {
    return (
        isGitDiffTabPath(path) ||
        isAgentTranscriptTabPath(path) ||
        isAgentTaskTabPath(path) ||
        isAgentTurnReviewTabPath(path) ||
        isAgentStatusTabPath(path) ||
        isExternalEditorTabPath(path) ||
        isFilePreviewTabPath(path) ||
        isSettingsTabPath(path) ||
        isUsageTabPath(path)
    );
}
