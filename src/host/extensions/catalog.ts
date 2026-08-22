import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import type {
    ContributedCommandDescriptor,
    ExtensionDescriptor,
    ExtensionError,
    ViewCatalogSnapshot,
    ViewContainerDescriptor,
    ViewDescriptor,
} from '../../../packages/protocol/src/domain/views';
import {
    MAX_VIEW_CATALOG_COMMANDS,
    MAX_VIEW_CATALOG_CONTAINERS,
    MAX_VIEW_CATALOG_EXTENSIONS,
    MAX_VIEW_CATALOG_VIEWS,
} from '../../../packages/protocol/src/domain/views';
import type { DiscoveredExtension, RejectedExtension } from './discovery';

const builtinContainers: ViewContainerDescriptor[] = [
    {
        id: 'caxri.files',
        location: 'secondarySidebar',
        source: { kind: 'builtin' },
        title: 'Files',
        icon: { kind: 'builtin', id: 'files' },
        commandId: 'secondarySidebar.showFiles',
        lifecycle: 'builtin',
    },
    {
        id: 'caxri.git',
        location: 'secondarySidebar',
        source: { kind: 'builtin' },
        title: 'Source Control',
        icon: { kind: 'builtin', id: 'git-branch' },
        commandId: 'secondarySidebar.showGit',
        lifecycle: 'builtin',
    },
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
        id: 'caxri.info',
        location: 'panel',
        source: { kind: 'builtin' },
        title: 'Info',
        icon: { kind: 'builtin', id: 'info' },
        commandId: 'panel.showInfo',
        lifecycle: 'builtin',
    },
];

const builtinViews: ViewDescriptor[] = builtinContainers.map((container) => ({
    id: `${container.id}.view`,
    containerId: container.id,
    source: { kind: 'builtin' },
    title: container.title,
    viewKind: {
        kind: 'builtin-react',
        component: container.id.slice('caxri.'.length) as 'files' | 'git' | 'logs' | 'info',
    },
}));

const builtinCommands: ContributedCommandDescriptor[] = builtinContainers.map((container) => ({
    id: container.commandId,
    title: `Show ${container.title}`,
    source: { kind: 'builtin' },
    lifecycle: 'builtin',
}));

function dataMime(path: string): string {
    return extname(path).toLowerCase() === '.svg' ? 'image/svg+xml' : 'image/png';
}

async function iconDataUrl(extension: DiscoveredExtension, icon: string): Promise<string> {
    const canonicalRoot = await realpath(extension.rootPath);
    const iconPath = await realpath(resolve(canonicalRoot, icon));
    const nested = relative(canonicalRoot, iconPath);
    if (nested.startsWith('..') || isAbsolute(nested))
        throw new Error(`Extension icon escapes its root: ${icon}`);
    const bytes = await readFile(iconPath);
    if (bytes.byteLength > 96 * 1_024) throw new Error(`Extension icon is too large: ${icon}`);
    return `data:${dataMime(icon)};base64,${bytes.toString('base64')}`;
}

export interface CatalogExtensionState {
    generation: number;
    lifecycle: ExtensionDescriptor['lifecycle'];
    error?: ExtensionError;
}

export async function buildViewCatalog(options: {
    extensions: readonly DiscoveredExtension[];
    rejected: readonly RejectedExtension[];
    states: ReadonlyMap<string, CatalogExtensionState>;
    revision: number;
}): Promise<ViewCatalogSnapshot> {
    const containers = [...builtinContainers];
    const views = [...builtinViews];
    const commands = [...builtinCommands];
    const extensions: ExtensionDescriptor[] = [];
    const ids = new Set<string>([
        ...containers.map(({ id }) => id),
        ...views.map(({ id }) => id),
        ...commands.map(({ id }) => id),
    ]);
    for (const extension of options.extensions) {
        if (extensions.length >= MAX_VIEW_CATALOG_EXTENSIONS) break;
        const state = options.states.get(extension.extensionId) ?? {
            generation: 0,
            lifecycle: 'discovered' as const,
        };
        let conflict: ExtensionError | undefined;
        const contributions = extension.manifest.contributes;
        const contributedViews = Object.values(contributions.views).flat();
        const contributedContainers = [
            ...contributions.viewsContainers.secondarySidebar,
            ...contributions.viewsContainers.panel,
        ];
        const contributedIds = [
            ...contributedContainers.map(({ id }) => id),
            ...contributedContainers.map(({ id }) => `viewContainers.show.${id}`),
            ...contributedViews.map(({ id }) => id),
            ...contributions.commands.map(({ command }) => command),
        ];
        const contributedViewCount = contributedViews.length;
        const isExceedsCatalogCapacity =
            containers.length + contributedContainers.length > MAX_VIEW_CATALOG_CONTAINERS ||
            views.length + contributedViewCount > MAX_VIEW_CATALOG_VIEWS ||
            commands.length + contributedContainers.length + contributions.commands.length >
                MAX_VIEW_CATALOG_COMMANDS;
        const duplicate = contributedIds.find(
            (id, index) => ids.has(id) || contributedIds.indexOf(id) !== index,
        );
        if (isExceedsCatalogCapacity)
            conflict = {
                code: 'PROVIDER_CAPACITY',
                message: `Extension contributions exceed the shared catalog capacity: ${extension.extensionId}`,
            };
        else if (duplicate)
            conflict = { code: 'DUPLICATE_ID', message: `Duplicate contribution id: ${duplicate}` };
        let icons = new Map<string, string>();
        if (!conflict)
            try {
                // Each extension is cataloged in order so the first conflicting contribution wins.
                icons = new Map(
                    // Icon reads are bounded and remain ordered by Promise.all below.
                    // eslint-disable-next-line no-await-in-loop
                    await Promise.all(
                        contributedContainers.map(
                            async (contribution) =>
                                [
                                    contribution.id,
                                    await iconDataUrl(extension, contribution.icon),
                                ] as const,
                        ),
                    ),
                );
            } catch (error) {
                conflict = {
                    code: 'MANIFEST_INVALID',
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        const lifecycle = conflict ? 'error' : state.lifecycle;
        const error = conflict ?? state.error;
        extensions.push({
            id: extension.extensionId,
            version: extension.manifest.version,
            generation: state.generation,
            lifecycle,
            ...(error && { error }),
        });
        if (conflict) continue;
        const viewContainers = contributions.viewsContainers;
        for (const location of ['secondarySidebar', 'panel'] as const) {
            const containerContributions = viewContainers[location];
            for (const contribution of containerContributions) {
                ids.add(contribution.id);
                containers.push({
                    id: contribution.id,
                    location,
                    source: { kind: 'extension', extensionId: extension.extensionId },
                    title: contribution.title,
                    icon: {
                        kind: 'resource',
                        dataUrl: icons.get(contribution.id)!,
                    },
                    commandId: `viewContainers.show.${contribution.id}`,
                    lifecycle,
                    ...(error && { error }),
                });
                commands.push({
                    id: `viewContainers.show.${contribution.id}`,
                    title: `Show ${contribution.title}`,
                    source: { kind: 'extension', extensionId: extension.extensionId },
                    lifecycle,
                });
                ids.add(`viewContainers.show.${contribution.id}`);
            }
        }
        for (const [containerId, viewContributions] of Object.entries(contributions.views)) {
            for (const contribution of viewContributions) {
                ids.add(contribution.id);
                views.push({
                    id: contribution.id,
                    containerId,
                    source: { kind: 'extension', extensionId: extension.extensionId },
                    title: contribution.name,
                    viewKind: { kind: 'tree' },
                    ...(contribution.when && { when: contribution.when }),
                });
            }
        }
        for (const contribution of contributions.commands) {
            ids.add(contribution.command);
            commands.push({
                id: contribution.command,
                title: contribution.title,
                ...(contribution.description && { description: contribution.description }),
                source: { kind: 'extension', extensionId: extension.extensionId },
                lifecycle,
            });
        }
    }
    const remainingRejected = options.rejected.slice(
        0,
        Math.max(0, MAX_VIEW_CATALOG_EXTENSIONS - extensions.length),
    );
    for (const rejected of remainingRejected)
        extensions.push({
            id: rejected.extensionId,
            version: rejected.version,
            generation: 0,
            lifecycle: 'error',
            error: rejected.error,
        });
    return { revision: options.revision, containers, views, commands, extensions };
}
