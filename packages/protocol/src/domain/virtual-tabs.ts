import { isAgentContextTabPath } from './agent-context-tab.js';
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
 * Predicate per virtual editor tab scheme, keyed by scheme. The `Record` type is the exhaustiveness check: adding a
 * name to `VirtualEditorTabScheme` without a predicate here fails typecheck, and so does a Renderer descriptor table
 * keyed by the same union. Schemes are mutually exclusive, so lookup order does not matter.
 */
const virtualEditorTabMatchers = {
    gitDiff: isGitDiffTabPath,
    agentTranscript: isAgentTranscriptTabPath,
    agentTask: isAgentTaskTabPath,
    agentTurnReview: isAgentTurnReviewTabPath,
    agentStatus: isAgentStatusTabPath,
    agentContext: isAgentContextTabPath,
    external: isExternalEditorTabPath,
    filePreview: isFilePreviewTabPath,
    settings: isSettingsTabPath,
    usage: isUsageTabPath,
} as const satisfies Record<string, (path: string) => boolean>;

/**
 * Every editor tab scheme that names a virtual surface instead of a Project file.
 */
export type VirtualEditorTabScheme = keyof typeof virtualEditorTabMatchers;

/**
 * All virtual tab schemes, for tests and tables that must enumerate them.
 */
export const virtualEditorTabSchemes = Object.keys(
    virtualEditorTabMatchers,
) as readonly VirtualEditorTabScheme[];

/**
 * The virtual scheme a tab path belongs to, or `undefined` for a Project file path.
 */
export function virtualEditorTabScheme(path: string): VirtualEditorTabScheme | undefined {
    return virtualEditorTabSchemes.find((scheme) => virtualEditorTabMatchers[scheme](path));
}

/**
 * Editor tab paths that name a virtual surface instead of a Project file. Virtual tabs are never read or written
 * through `files.*` and keep their encoded path across file renames. Save and dirty-close confirmation skip them,
 * except an external document, which saves through Main's `externalDocument.write` instead. Every new virtual tab
 * scheme is registered in `virtualEditorTabMatchers` so all of those guards stay in one place.
 */
export function isVirtualEditorTabPath(path: string): boolean {
    return virtualEditorTabScheme(path) !== undefined;
}
