/**
 * One level in the Add Project browser. `path` is relative to the computer's home directory; `null` is home itself.
 */
export interface ProjectBrowserLevel {
    name: string;
    path: string | null;
}

export const PROJECT_BROWSER_HOME: ProjectBrowserLevel = { name: 'Home', path: null };

export const enterProjectBrowserLevel = (
    stack: readonly ProjectBrowserLevel[],
    level: ProjectBrowserLevel,
): ProjectBrowserLevel[] => [...stack, level];

/**
 * Leaving the home level is not a browser step; the caller closes the screen instead.
 */
export const leaveProjectBrowserLevel = (
    stack: readonly ProjectBrowserLevel[],
): ProjectBrowserLevel[] => (stack.length > 1 ? stack.slice(0, -1) : [...stack]);

export const currentProjectBrowserLevel = (
    stack: readonly ProjectBrowserLevel[],
): ProjectBrowserLevel => stack.at(-1) ?? PROJECT_BROWSER_HOME;

/**
 * Home is a container of Projects, never a Project itself.
 */
export const canAddProjectBrowserLevel = (
    level: ProjectBrowserLevel,
): level is ProjectBrowserLevel & {
    path: string;
} => level.path !== null;

/**
 * A Git repository is the usual Project, and a folder with no subfolders cannot be opened to reach the footer's Add, so
 * both offer Add on the row itself; without it a leaf folder would be a dead end.
 */
export const canAddProjectBrowserEntry = (entry: {
    hasChildren: boolean;
    isGitRepository: boolean;
}): boolean => entry.isGitRepository || !entry.hasChildren;
