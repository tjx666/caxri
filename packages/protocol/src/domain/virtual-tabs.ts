import { isAgentTranscriptTabPath } from './agent-transcript.js';
import { isGitDiffTabPath } from './git-diff.js';

/**
 * Editor tab paths that name a virtual surface instead of a Project file. Virtual tabs are never read or written
 * through `files.*`, are skipped by save and dirty-close confirmation, and keep their encoded path across file renames.
 * Every new virtual tab scheme must be added here so all of those guards stay in one place.
 */
export function isVirtualEditorTabPath(path: string): boolean {
    return isGitDiffTabPath(path) || isAgentTranscriptTabPath(path);
}
