export const MACOS_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';

interface LowCostSandboxDenials {
    /**
     * Absolute file paths denied exactly, for instruction files an Agent CLI cannot be told to skip.
     */
    literals: readonly string[];
    /**
     * Absolute directory roots denied recursively, normally the Project the Session is attached to.
     */
    subpaths: readonly string[];
}

/**
 * Builds the macOS sandbox profile that wraps a low-cost text generation.
 *
 * Paste summaries are bounded text transformations, so an Agent CLI must not silently widen them by loading Project or
 * global instruction files. Every provider offers switches for some of those inputs and none for all of them, so the
 * host sandbox is the only place the guarantee can be made uniformly. The profile stays permissive by default so
 * provider authentication, model network access, and the provider's own state directory keep working; only the named
 * reads are removed. The denial is by path, not by purpose: a Project rooted at an ancestor of the provider's state
 * directory or of the CLI's runtime (a home directory added as a Project) makes every generation fail; the paste flow
 * then falls back to the unsummarized paste.
 *
 * Paths must already be canonical. `sandbox-exec` matches the resolved path, so a literal or subpath that still
 * contains a symlink component would silently fail to match the file the CLI actually opens.
 */
export function lowCostSandboxProfile(denials: LowCostSandboxDenials): string {
    return [
        '(version 1)',
        '(allow default)',
        ...denials.subpaths.map((path) => `(deny file-read* (subpath ${JSON.stringify(path)}))`),
        ...denials.literals.map((path) => `(deny file-read* (literal ${JSON.stringify(path)}))`),
    ].join(' ');
}
