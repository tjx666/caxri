import { describe, expect, it } from 'vitest';

import {
    extensionManifestSchema,
    extensionTreeViewStatesSchema,
    MAX_TREE_ITEM_TOOLTIP_MARKDOWN,
    sourceControlActionResultSchema,
    sourceControlHistoryPageSchema,
    sourceControlViewModelSchema,
    sourceControlViewStatesSchema,
    treeItemSchema,
    viewCatalogSnapshotSchema,
    viewContainerIdSchema,
} from '../views';

describe('extension view contracts', () => {
    it('accepts bounded rich tree tooltips with HTTP links only', () => {
        const baseItem = {
            handle: 'id:deployment',
            label: 'Deployment',
            accessibilityLabel: 'Deployment',
            collapsibleState: 'none' as const,
        };
        expect(
            treeItemSchema.parse({
                ...baseItem,
                tooltip: {
                    kind: 'rich',
                    title: 'preview',
                    badge: { label: 'success', tone: 'success' },
                    rows: [
                        {
                            label: 'alias',
                            value: 'project-abc-team.vercel.app',
                            url: 'https://project-abc-team.vercel.app',
                        },
                        {
                            label: 'inspect',
                            value: 'logs',
                            url: 'https://vercel.com/team/project/abc',
                        },
                    ],
                },
            }).tooltip,
        ).toMatchObject({ kind: 'rich', rows: [{ label: 'alias' }, { label: 'inspect' }] });
        expect(
            treeItemSchema.parse({
                ...baseItem,
                tooltip: {
                    kind: 'rich',
                    title: 'gh: rate limited',
                    description: 'Refresh after the API limit resets.',
                },
            }).tooltip,
        ).toEqual({
            kind: 'rich',
            title: 'gh: rate limited',
            description: 'Refresh after the API limit resets.',
            rows: [],
        });
        expect(
            treeItemSchema.safeParse({
                ...baseItem,
                tooltip: {
                    kind: 'rich',
                    title: 'preview',
                    description: 'x'.repeat(1_025),
                },
            }).success,
        ).toBe(false);
        expect(
            treeItemSchema.safeParse({
                ...baseItem,
                tooltip: {
                    kind: 'rich',
                    title: 'preview',
                    rows: [{ label: 'alias', value: 'unsafe', url: 'file:///etc/passwd' }],
                },
            }).success,
        ).toBe(false);
        expect(
            treeItemSchema.safeParse({
                ...baseItem,
                tooltip: {
                    kind: 'rich',
                    title: 'preview',
                    rows: Array.from({ length: 9 }, (_, index) => ({
                        label: `row-${index}`,
                        value: 'value',
                    })),
                },
            }).success,
        ).toBe(false);
        expect(
            treeItemSchema.safeParse({
                ...baseItem,
                tooltip: {
                    kind: 'rich',
                    title: 'preview',
                    rows: [
                        { label: 'alias', value: 'duplicate' },
                        { label: 'alias', value: 'duplicate' },
                    ],
                },
            }).success,
        ).toBe(false);
    });

    it('accepts a bounded Markdown tooltip body that replaces the plain description', () => {
        const baseItem = {
            handle: 'id:thread',
            label: 'app.ts:12',
            accessibilityLabel: 'app.ts:12',
            collapsibleState: 'none' as const,
        };
        const tooltip = (fields: Record<string, string>) => ({
            ...baseItem,
            tooltip: { kind: 'rich', title: 'app.ts:12', ...fields },
        });
        const oversized = 'x'.repeat(MAX_TREE_ITEM_TOOLTIP_MARKDOWN + 1);
        expect(treeItemSchema.parse(tooltip({ markdown: 'Rename `helper`.' })).tooltip).toEqual({
            kind: 'rich',
            title: 'app.ts:12',
            markdown: 'Rename `helper`.',
            rows: [],
        });
        expect(treeItemSchema.safeParse(tooltip({ markdown: oversized })).success).toBe(false);
        expect(
            treeItemSchema.safeParse(tooltip({ description: 'plain', markdown: '**rich**' }))
                .success,
        ).toBe(false);
    });

    it('bounds stable tree identity and persisted per-view state', () => {
        expect(
            treeItemSchema.parse({
                handle: 'id:repository',
                id: 'repository',
                label: 'Repository',
                accessibilityLabel: 'Repository',
                collapsibleState: 'expanded',
                variant: 'header',
            }),
        ).toMatchObject({ id: 'repository', variant: 'header' });
        expect(
            treeItemSchema.parse({
                handle: 'id:message',
                id: 'message',
                label: 'No Git repository',
                accessibilityLabel: 'No Git repository',
                collapsibleState: 'none',
                variant: 'message',
            }),
        ).toMatchObject({ id: 'message', variant: 'message' });
        expect(
            treeItemSchema.safeParse({
                handle: 'id:collapsible-message',
                label: 'Invalid message',
                accessibilityLabel: 'Invalid message',
                collapsibleState: 'collapsed',
                variant: 'message',
            }).success,
        ).toBe(false);
        expect(
            treeItemSchema.safeParse({
                handle: 'id:unsupported-variant',
                label: 'Unsupported variant',
                accessibilityLabel: 'Unsupported variant',
                collapsibleState: 'none',
                variant: 'card',
            }).success,
        ).toBe(false);
        expect(
            treeItemSchema.safeParse({
                handle: 'id:oversized',
                id: 'x'.repeat(481),
                label: 'Oversized',
                accessibilityLabel: 'Oversized',
                collapsibleState: 'none',
            }).success,
        ).toBe(false);
        expect(
            extensionTreeViewStatesSchema.safeParse({
                'publisher.fixture.tree': {
                    expandedItemIds: ['repository'],
                    initializedItemIds: ['repository'],
                    focusedItemId: 'repository',
                },
            }).success,
        ).toBe(true);
        expect(
            sourceControlViewStatesSchema.safeParse({
                'caxri.git.sourceControl': {
                    expandedDirectories: { 'changes:repository:src': false },
                    expandedGroups: { changes: false },
                    expandedProviders: { repository: true },
                    modeId: 'changes',
                },
            }).success,
        ).toBe(true);
    });

    it('keeps unknown namespaced ViewContainer ids as bounded strings', () => {
        expect(viewContainerIdSchema.parse('publisher.experimental-view')).toBe(
            'publisher.experimental-view',
        );
        expect(viewContainerIdSchema.safeParse(' bad id ').success).toBe(false);
        expect(viewContainerIdSchema.safeParse('x'.repeat(201)).success).toBe(false);
    });

    it('accepts only ESM extension entries and the supported contribution locations', () => {
        const manifest = extensionManifestSchema.parse({
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: ['projects.read'] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'caxri.fixture',
                            title: 'Fixture',
                            icon: { kind: 'resource', path: 'media/fixture.svg' },
                        },
                    ],
                },
                views: {
                    'caxri.fixture': [{ id: 'caxri.fixture.tree', name: 'Fixture', type: 'tree' }],
                },
            },
        });
        expect(manifest.contributes.viewsContainers.panel).toEqual([]);

        const orderedManifest = extensionManifestSchema.parse({
            ...manifest,
            contributes: {
                ...manifest.contributes,
                viewsContainers: {
                    secondarySidebar: [
                        {
                            ...manifest.contributes.viewsContainers.secondarySidebar[0],
                            order: 200,
                        },
                    ],
                },
            },
        });
        expect(orderedManifest.contributes.viewsContainers.secondarySidebar[0].order).toBe(200);
        for (const order of [-1, 1.5, 10_001])
            expect(
                extensionManifestSchema.safeParse({
                    ...orderedManifest,
                    contributes: {
                        ...orderedManifest.contributes,
                        viewsContainers: {
                            secondarySidebar: [
                                {
                                    ...orderedManifest.contributes.viewsContainers
                                        .secondarySidebar[0],
                                    order,
                                },
                            ],
                        },
                    },
                }).success,
            ).toBe(false);

        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                type: 'commonjs',
                main: './dist/extension.cjs',
            }).success,
        ).toBe(false);
        for (const path of ['../secret.svg', '/tmp/secret.svg', 'media/icon.js'])
            expect(
                extensionManifestSchema.safeParse({
                    ...manifest,
                    contributes: {
                        ...manifest.contributes,
                        viewsContainers: {
                            secondarySidebar: [
                                {
                                    id: 'caxri.fixture',
                                    title: 'Fixture',
                                    icon: { kind: 'resource', path },
                                },
                            ],
                            panel: [],
                        },
                    },
                }).success,
            ).toBe(false);
    });

    it('accepts only explicit resource and allowlisted builtin container icons', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'caxri.fixture',
                            title: 'Fixture',
                            icon: { kind: 'builtin', id: 'status' },
                        },
                    ],
                },
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    viewsContainers: {
                        secondarySidebar: [
                            {
                                id: 'caxri.fixture',
                                title: 'Fixture',
                                icon: { kind: 'builtin', id: 'arbitrary-lucide-name' },
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('rejects manifest fields that have no runtime consumer', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                views: {
                    'caxri.fixture': [{ id: 'caxri.fixture.tree', name: 'Fixture', type: 'tree' }],
                },
            },
        };

        expect(
            extensionManifestSchema.safeParse({ ...manifest, activationEvents: ['*'] }).success,
        ).toBe(false);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    views: {
                        'caxri.fixture': [
                            {
                                id: 'caxri.fixture.tree',
                                name: 'Fixture',
                                type: 'tree',
                                when: 'never',
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('reserves enough container-id capacity for the generated show command', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: `publisher.${'x'.repeat(190)}`,
                            title: 'Fixture',
                            icon: { kind: 'builtin', id: 'status' },
                        },
                    ],
                },
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(false);
    });

    it('keeps semantic toolbar roles on Workbench Core resource views', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: ['git.read'] },
            contributes: {
                views: {
                    'caxri.fixture': [
                        {
                            id: 'caxri.fixture.sourceControl',
                            name: 'Source Control',
                            type: 'source-control',
                        },
                    ],
                },
                commands: [
                    {
                        command: 'caxri.fixture.refresh',
                        title: 'Refresh',
                        allowInEditable: true,
                    },
                ],
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    ...manifest.contributes,
                    views: {
                        'caxri.fixture': [
                            {
                                ...manifest.contributes.views['caxri.fixture'][0],
                                type: 'resource-explorer',
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    ...manifest.contributes,
                    views: {
                        'caxri.fixture': [
                            {
                                ...manifest.contributes.views['caxri.fixture'][0],
                                actions: [
                                    {
                                        command: 'caxri.fixture.refresh',
                                        role: 'source.refresh',
                                    },
                                ],
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('accepts only the refresh toolbar role on extension tree views', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                views: {
                    'caxri.fixture': [
                        {
                            id: 'caxri.fixture.tree',
                            name: 'Fixture',
                            type: 'tree',
                            actions: [
                                {
                                    command: 'caxri.fixture.refresh',
                                    role: 'resource.refresh',
                                },
                            ],
                        },
                    ],
                },
                commands: [{ command: 'caxri.fixture.refresh', title: 'Refresh' }],
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    ...manifest.contributes,
                    views: {
                        'caxri.fixture': [
                            {
                                ...manifest.contributes.views['caxri.fixture'][0],
                                actions: [
                                    {
                                        command: 'caxri.fixture.refresh',
                                        role: 'resource.createFile',
                                    },
                                ],
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('requires settings.read for declared controlled-view configuration dependencies', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.18' },
            caxri: { capabilities: ['settings.read'] },
            contributes: {
                views: {
                    'caxri.fixture': [
                        {
                            id: 'caxri.fixture.sourceControl',
                            name: 'Source Control',
                            type: 'source-control',
                            configurationDependencies: ['git.fetchGitHubAvatars'],
                        },
                    ],
                },
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                caxri: { capabilities: [] },
            }).success,
        ).toBe(false);
    });

    it('bounds generic Source Control models and revision-fenced action results', () => {
        const action = {
            id: 'action-1',
            label: 'Refresh',
            icon: { kind: 'theme', id: 'refresh' },
            command: { id: 'publisher.fixture.refresh' },
            pressed: true,
        };
        const model = {
            revision: '7',
            title: 'Provider View',
            accessibilityLabel: 'Provider resources',
            modeAccessibilityLabel: 'Provider mode',
            modes: [
                {
                    id: 'primary',
                    label: 'Primary',
                    icon: { kind: 'theme', id: 'list' },
                    command: { id: 'publisher.fixture.primary' },
                },
            ],
            selectedModeId: 'primary',
            refreshAction: action,
            headerActions: [action],
            fileHistory: {
                label: 'File History',
                description: 'README.md',
                tooltip: '/private/project/README.md',
                emptyMessage: 'Open a file to view its history.',
                path: 'README.md',
                history: {
                    id: 'repository-1',
                    label: 'File History',
                    command: { id: 'publisher.fixture.historyPage' },
                    pathInputLabel: 'History path',
                    pathInputPlaceholder: 'Filter by path',
                    clearPathLabel: 'Clear history path',
                    loadingMessage: 'Loading file history...',
                    emptyMessage: 'No commits found for this file.',
                    loadMoreLabel: 'Load more',
                    loadingMoreLabel: 'Loading more...',
                    loadErrorMessage: 'Unable to load file history.',
                    detailsLoadingMessage: 'Loading commit details...',
                    detailsErrorMessage: 'Unable to load commit details.',
                    detailsLabel: 'Commit details',
                    detailsEmptyMessage: 'No changed files.',
                    detailsTruncatedMessage: 'More changed files are not shown.',
                    itemAccessibilityLabelPrefix: 'Commit',
                    itemActivation: 'action' as const,
                    pageSize: 25,
                    revision: '7',
                },
            },
            providers: [],
        };

        expect(sourceControlViewModelSchema.parse(model)).toEqual(model);
        expect(
            sourceControlHistoryPageSchema.parse({
                revision: '7',
                items: [
                    {
                        id: 'commit-1',
                        label: 'Update README',
                        description: 'abc1234',
                        timestamp: 1,
                        tooltipTimestamp: 'January 1, 1970',
                        author: 'Fixture Author',
                        authorFallback: 'FA',
                        decorations: [],
                        action,
                    },
                ],
            }).items[0]?.action,
        ).toEqual(action);
        expect(
            sourceControlActionResultSchema.parse({
                revision: '7',
                effects: [{ kind: 'open-editor', resource: 'git-diff:repo-1/README.md' }],
                refresh: false,
            }),
        ).toMatchObject({ revision: '7', refresh: false });
        expect(
            sourceControlViewModelSchema.safeParse({
                ...model,
                revision: '',
            }).success,
        ).toBe(false);
    });

    it('carries a source control provider root path independently of its tooltip', () => {
        const provider = {
            id: 'repository-1',
            label: 'project',
            icon: { kind: 'theme' as const, id: 'folder-git' },
            // Decorated display text: a consumer that reads this as a path resolves the wrong file.
            tooltip: '/authorized/project (2 changes)',
            rootPath: '/authorized/project',
            description: 'main',
            descriptionAccessibilityLabel: 'On branch main',
            descriptionTooltip: 'main',
            countLabel: ' · 2',
            expandedByDefault: true,
            actions: [],
            groups: [],
        };
        const model = {
            revision: '7',
            title: 'Source Control',
            accessibilityLabel: 'Source Control',
            modeAccessibilityLabel: 'Source Control mode',
            modes: [],
            selectedModeId: 'working',
            refreshAction: {
                id: 'publisher.fixture.refresh',
                label: 'Refresh',
                icon: { kind: 'theme' as const, id: 'refresh' },
                command: { id: 'publisher.fixture.refresh' },
            },
            providers: [provider],
        };

        const rootlessEntries = Object.entries(provider).filter(([key]) => key !== 'rootPath');
        const rootless = Object.fromEntries(rootlessEntries);

        expect(sourceControlViewModelSchema.parse(model).providers[0]).toEqual(provider);
        // A provider without a filesystem root stays valid; consumers then disable path-dependent affordances.
        expect(
            sourceControlViewModelSchema.parse({ ...model, providers: [rootless] }).providers[0],
        ).not.toHaveProperty('rootPath');
        expect(
            sourceControlViewModelSchema.safeParse({
                ...model,
                providers: [{ ...provider, rootPath: '' }],
            }).success,
        ).toBe(false);
        // A synced, clean repository hides every zero count, leaving an empty count label.
        expect(
            sourceControlViewModelSchema.safeParse({
                ...model,
                providers: [{ ...provider, countLabel: '' }],
            }).success,
        ).toBe(true);

        const externalLink = {
            url: 'https://example.com/owner/repository/pull/7',
            label: 'Open pull request #7 on the web',
        };
        expect(
            sourceControlViewModelSchema.parse({
                ...model,
                providers: [{ ...provider, externalLink }],
            }).providers[0].externalLink,
        ).toEqual(externalLink);
        // The Renderer hands the value straight to the default browser, so a non-URL must never reach it.
        expect(
            sourceControlViewModelSchema.safeParse({
                ...model,
                providers: [{ ...provider, externalLink: { ...externalLink, url: 'pull/7' } }],
            }).success,
        ).toBe(false);
    });

    it('validates one unified builtin and extension catalog shape', () => {
        expect(
            viewCatalogSnapshotSchema.parse({
                revision: 1,
                containers: [
                    {
                        id: 'caxri.logs',
                        location: 'panel',
                        source: { kind: 'builtin' },
                        title: 'Logs',
                        icon: { kind: 'builtin', id: 'scroll-text' },
                        commandId: 'panel.showLogs',
                        lifecycle: 'builtin',
                    },
                    {
                        id: 'caxri.fixture',
                        location: 'secondarySidebar',
                        source: { kind: 'extension', extensionId: 'caxri.fixture' },
                        title: 'Fixture',
                        icon: { kind: 'theme', id: 'beaker' },
                        commandId: 'caxri.fixture.show',
                        lifecycle: 'discovered',
                    },
                ],
                views: [],
                commands: [],
                extensions: [
                    {
                        id: 'caxri.fixture',
                        version: '1.0.0',
                        generation: 0,
                        lifecycle: 'discovered',
                    },
                ],
            }).containers,
        ).toHaveLength(2);
    });
});
