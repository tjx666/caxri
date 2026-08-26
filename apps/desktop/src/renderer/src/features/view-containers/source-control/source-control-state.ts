export interface SourceControlViewNavigation {
    expandedDirectories: Record<string, boolean | undefined>;
    expandedGroups: Record<string, boolean | undefined>;
    expandedProviders: Record<string, boolean | undefined>;
    modeId?: string;
}

export function defaultSourceControlViewNavigation(): SourceControlViewNavigation {
    return {
        expandedDirectories: {},
        expandedGroups: {},
        expandedProviders: {},
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
