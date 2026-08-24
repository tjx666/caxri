export type GitPanelMode = 'commit' | 'pull-request' | 'working';

export interface GitPanelNavigation {
    expandedDirectories: Record<string, boolean | undefined>;
    expandedRepositories: Record<string, boolean | undefined>;
    mode: GitPanelMode;
}

export function defaultGitPanelNavigation(): GitPanelNavigation {
    return {
        expandedDirectories: {},
        expandedRepositories: {},
        mode: 'working',
    };
}

export function gitPanelNavigationForScope(
    navigationByScope: Readonly<Record<string, GitPanelNavigation>>,
    scope: string | undefined,
): GitPanelNavigation {
    return scope
        ? (navigationByScope[scope] ?? defaultGitPanelNavigation())
        : defaultGitPanelNavigation();
}

export function updateGitPanelNavigation(
    navigationByScope: Readonly<Record<string, GitPanelNavigation>>,
    scope: string,
    navigation: GitPanelNavigation,
    patch: Partial<GitPanelNavigation>,
): Record<string, GitPanelNavigation> {
    return {
        ...navigationByScope,
        [scope]: { ...navigation, ...patch },
    };
}
