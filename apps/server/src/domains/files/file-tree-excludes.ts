import type { GlobPatternSettings } from '@caxri/utils';
import { isGlobMatch } from '@caxri/utils';

export type FileTreeExcludes = GlobPatternSettings;

/**
 * Matches a Project-relative path against enabled `files.exclude` glob entries.
 */
export function isFileTreeExcludeMatch(relativePath: string, excludes: FileTreeExcludes): boolean {
    return isGlobMatch(relativePath, excludes);
}
