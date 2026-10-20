import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import type {
    ContributedCommandDescriptor,
    ExtensionDescriptor,
    ExtensionError,
    ViewCatalogSnapshot,
    ViewContainerDescriptor,
    ViewDescriptor,
} from '@caxri/protocol';
import {
    MAX_VIEW_CATALOG_COMMANDS,
    MAX_VIEW_CATALOG_CONTAINERS,
    MAX_VIEW_CATALOG_EXTENSIONS,
    MAX_VIEW_CATALOG_VIEWS,
    MAX_VIEW_ICON_DATA_URL_LENGTH,
    SHOW_VIEW_CONTAINER_COMMAND_PREFIX,
    viewCatalogSnapshotSchema,
    workbenchCoreContributions,
} from '@caxri/protocol';
import { readBoundedRegularFile } from '@caxri/system';

import type { DiscoveredExtension, RejectedExtension } from './discovery';

const builtinContainers: ViewContainerDescriptor[] = [
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
        component: container.id.slice('caxri.'.length) as 'logs' | 'info',
    },
}));

const builtinCommands: ContributedCommandDescriptor[] = builtinContainers.map((container) => ({
    id: container.commandId,
    title: `Show ${container.title}`,
    source: { kind: 'builtin' },
    lifecycle: 'builtin',
}));

const coreContainers = workbenchCoreContributions.map(({ container }) => container);
const coreViews = workbenchCoreContributions.flatMap(({ views }) => views);
const coreCommands = workbenchCoreContributions.flatMap(({ commands }) => commands);

function dataMime(path: string): string {
    return extname(path).toLowerCase() === '.svg' ? 'image/svg+xml' : 'image/png';
}

function catalogErrorContainerId(extensionId: string): string {
    const digest = createHash('sha256').update(extensionId).digest('hex').slice(0, 16);
    return `extension-error.${digest}`;
}

async function iconDataUrl(extension: DiscoveredExtension, icon: string): Promise<string> {
    const canonicalRoot = await realpath(extension.rootPath);
    const iconPath = await realpath(resolve(canonicalRoot, icon));
    const nested = relative(canonicalRoot, iconPath);
    if (nested.startsWith('..') || isAbsolute(nested))
        throw new Error(`Extension icon escapes its root: ${icon}`);
    const prefix = `data:${dataMime(icon)};base64,`;
    const maxSourceBytes = Math.floor((MAX_VIEW_ICON_DATA_URL_LENGTH - prefix.length) / 4) * 3;
    // The shared bounded reader refuses a FIFO at the icon path instead of blocking the catalog build on its writer.
    const source = await readBoundedRegularFile(iconPath, maxSourceBytes, {
        capacityMessage: `Extension icon is too large: ${icon}`,
        notRegularFileMessage: `Extension icon is not a regular file: ${icon}`,
    });
    return `${prefix}${source.toString('base64')}`;
}

async function resourceIconEntry(
    extension: DiscoveredExtension,
    id: string,
    path: string,
): Promise<readonly [string, string]> {
    const dataUrl = await iconDataUrl(extension, path);
    return [id, dataUrl];
}

export interface CatalogExtensionState {
    generation: number;
    lifecycle: ExtensionDescriptor['lifecycle'];
    error?: ExtensionError;
}

function orderedContainers(
    containers: readonly ViewContainerDescriptor[],
    manifestOrders: ReadonlyMap<string, number>,
): ViewContainerDescriptor[] {
    const queues = new Map(
        ['secondarySidebar', 'panel'].map((location) => [
            location,
            containers
                .filter((container) => container.location === location)
                .toSorted(
                    (left, right) =>
                        (manifestOrders.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
                        (manifestOrders.get(right.id) ?? Number.MAX_SAFE_INTEGER),
                ),
        ]),
    );
    const offsets = new Map<string, number>();
    return containers.map((container) => {
        const offset = offsets.get(container.location) ?? 0;
        offsets.set(container.location, offset + 1);
        return queues.get(container.location)![offset];
    });
}

export async function buildViewCatalog(options: {
    extensions: readonly DiscoveredExtension[];
    rejected: readonly RejectedExtension[];
    states: ReadonlyMap<string, CatalogExtensionState>;
    revision: number;
}): Promise<ViewCatalogSnapshot> {
    const containers = [...builtinContainers, ...coreContainers];
    const views = [...builtinViews, ...coreViews];
    const commands = [...builtinCommands, ...coreCommands];
    const extensions: ExtensionDescriptor[] = [];
    const manifestOrders = new Map<string, number>(
        workbenchCoreContributions.map(({ container, order }) => [container.id, order]),
    );
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
            ...contributedContainers.map(
                ({ command, id }) => command ?? `${SHOW_VIEW_CONTAINER_COMMAND_PREFIX}${id}`,
            ),
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
        let resourceIcons = new Map<string, string>();
        if (!conflict)
            try {
                // Each extension is cataloged in order so the first conflicting contribution wins.
                resourceIcons = new Map(
                    // eslint-disable-next-line no-await-in-loop -- Preserve deterministic extension conflict ownership.
                    await Promise.all(
                        contributedContainers.flatMap((contribution) =>
                            contribution.icon.kind === 'resource'
                                ? [
                                      resourceIconEntry(
                                          extension,
                                          contribution.id,
                                          contribution.icon.path,
                                      ),
                                  ]
                                : [],
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
        if (conflict) {
            const containerId = catalogErrorContainerId(extension.extensionId);
            const commandId = `${SHOW_VIEW_CONTAINER_COMMAND_PREFIX}${containerId}`;
            if (
                containers.length < MAX_VIEW_CATALOG_CONTAINERS &&
                commands.length < MAX_VIEW_CATALOG_COMMANDS &&
                !ids.has(containerId) &&
                !ids.has(commandId)
            ) {
                ids.add(containerId);
                ids.add(commandId);
                containers.push({
                    id: containerId,
                    location: 'secondarySidebar',
                    source: { kind: 'extension', extensionId: extension.extensionId },
                    title: extension.extensionId,
                    icon: { kind: 'builtin', id: 'beaker' },
                    commandId,
                    lifecycle: 'error',
                    error: conflict,
                });
                commands.push({
                    id: commandId,
                    title: extension.extensionId,
                    source: { kind: 'extension', extensionId: extension.extensionId },
                    lifecycle: 'error',
                });
            }
            continue;
        }
        const viewContainers = contributions.viewsContainers;
        for (const location of ['secondarySidebar', 'panel'] as const) {
            const containerContributions = viewContainers[location];
            for (const contribution of containerContributions) {
                const commandId =
                    contribution.command ??
                    `${SHOW_VIEW_CONTAINER_COMMAND_PREFIX}${contribution.id}`;
                ids.add(contribution.id);
                if (contribution.order !== undefined)
                    manifestOrders.set(contribution.id, contribution.order);
                containers.push({
                    id: contribution.id,
                    location,
                    source: { kind: 'extension', extensionId: extension.extensionId },
                    title: contribution.title,
                    icon:
                        contribution.icon.kind === 'builtin'
                            ? contribution.icon
                            : {
                                  kind: 'resource',
                                  dataUrl: resourceIcons.get(contribution.id)!,
                              },
                    commandId,
                    lifecycle,
                    ...(error && { error }),
                });
                commands.push({
                    id: commandId,
                    title: `Show ${contribution.title}`,
                    allowInEditable: true,
                    source: { kind: 'extension', extensionId: extension.extensionId },
                    lifecycle,
                });
                ids.add(commandId);
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
                    viewKind: { kind: contribution.type },
                    ...(contribution.badge && { badge: contribution.badge }),
                    ...(contribution.presentation && {
                        presentation: contribution.presentation,
                    }),
                    ...(contribution.configurationDependencies && {
                        configurationDependencies: contribution.configurationDependencies,
                    }),
                    ...(contribution.actions && {
                        actions: contribution.actions.map(({ command, role }) => ({
                            commandId: command,
                            role,
                        })),
                    }),
                });
            }
        }
        for (const contribution of contributions.commands) {
            ids.add(contribution.command);
            commands.push({
                id: contribution.command,
                title: contribution.title,
                ...(contribution.description && { description: contribution.description }),
                ...(contribution.allowInEditable && { allowInEditable: true }),
                ...(contribution.palette === false && { palette: false }),
                source: { kind: 'extension', extensionId: extension.extensionId },
                lifecycle,
            });
        }
    }
    const remainingRejected = options.rejected.slice(
        0,
        Math.max(0, MAX_VIEW_CATALOG_EXTENSIONS - extensions.length),
    );
    for (const rejected of remainingRejected) {
        extensions.push({
            id: rejected.extensionId,
            version: rejected.version,
            generation: 0,
            lifecycle: 'error',
            error: rejected.error,
        });
        const commandId = `${SHOW_VIEW_CONTAINER_COMMAND_PREFIX}${rejected.extensionId}`;
        if (
            containers.length >= MAX_VIEW_CATALOG_CONTAINERS ||
            commands.length >= MAX_VIEW_CATALOG_COMMANDS ||
            ids.has(rejected.extensionId) ||
            ids.has(commandId)
        )
            continue;
        ids.add(rejected.extensionId);
        ids.add(commandId);
        containers.push({
            id: rejected.extensionId,
            location: 'secondarySidebar',
            source: { kind: 'extension', extensionId: rejected.extensionId },
            title: rejected.extensionId,
            icon: { kind: 'builtin', id: 'beaker' },
            commandId,
            lifecycle: 'error',
            error: rejected.error,
        });
        commands.push({
            id: commandId,
            title: `Show ${rejected.extensionId}`,
            source: { kind: 'extension', extensionId: rejected.extensionId },
            lifecycle: 'error',
        });
    }
    return viewCatalogSnapshotSchema.parse({
        revision: options.revision,
        containers: orderedContainers(containers, manifestOrders),
        views,
        commands,
        extensions,
    });
}
