export type SourceControlViewMode = 'commit' | 'pull-request' | 'working';

export interface SourceControlViewNavigation {
    expandedDirectories: Record<string, boolean | undefined>;
    expandedRepositories: Record<string, boolean | undefined>;
    mode: SourceControlViewMode;
}

export function defaultSourceControlViewNavigation(): SourceControlViewNavigation {
    return {
        expandedDirectories: {},
        expandedRepositories: {},
        mode: 'working',
    };
}

export function sourceControlNavigationForScope(
    navigationByScope: Readonly<Record<string, SourceControlViewNavigation>>,
    scope: string | undefined,
): SourceControlViewNavigation {
    return scope
        ? (navigationByScope[scope] ?? defaultSourceControlViewNavigation())
        : defaultSourceControlViewNavigation();
}

export function updateSourceControlViewNavigation(
    navigationByScope: Readonly<Record<string, SourceControlViewNavigation>>,
    scope: string,
    navigation: SourceControlViewNavigation,
    patch: Partial<SourceControlViewNavigation>,
): Record<string, SourceControlViewNavigation> {
    return {
        ...navigationByScope,
        [scope]: { ...navigation, ...patch },
    };
}
