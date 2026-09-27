import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';

import type { SourceControlAction, SourceControlResource } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import { startFilePathDrag } from '../../../lib/file-drag';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../../lib/repository-file-path';
import { cn } from '../../../lib/utilities';
import { openFile } from '../../editor/document-commands';
import { sourceControlDecorationClassName } from './source-control-decorations';
import { SourceControlIcon } from './source-control-icon';
import { sourceControlActionMenuItems } from './source-control-row-menu';
import type { SourceControlTreeNode } from './source-control-tree';
import { sourceControlDirectoryExpansionKeys } from './source-control-tree';
import { SourceControlTreeRow } from './source-control-tree-row';

const resourceRowClassName =
    'git-row flex w-full items-center gap-2 h-7 px-2 border-0 bg-surface text-left cursor-pointer';

/**
 * The name and the status letter of a changed row wear the same `--git-*` color, which is the same color that file's
 * name wears in the Files tree and on its tab. `undefined` for an undecorated row, which keeps the row's own color.
 */
function resourceColorClassName(resource: SourceControlResource): string | undefined {
    return resource.decoration && sourceControlDecorationClassName(resource.decoration);
}

function Decoration({
    className,
    resource,
}: {
    className?: string;
    resource: SourceControlResource;
}) {
    const value = resource.decoration;
    if (!value) return null;
    return (
        <span
            className={cn(
                `status status-${value.identifier}`,
                'min-w-4 flex-none text-center font-mono font-bold',
                sourceControlDecorationClassName(value),
                className,
            )}
        >
            {value.label}
        </span>
    );
}

function handleResourceDragStart(
    event: DragEvent<HTMLButtonElement>,
    resourcePath: string | undefined,
): void {
    if (!resourcePath) return;
    startFilePathDrag(event.dataTransfer, resourcePath, false);
}

/**
 * File and folder rows omit a hover tooltip on purpose: the path is already the row's accessible name, and a
 * cursor-anchored card sits over the adjacent diff while the user is reading it. Both advertise their Option-click
 * gesture through `aria-keyshortcuts` instead: a file row only when it has a working copy to open, a folder row
 * unconditionally, since every folder supports the Alt+Enter / Alt-click recursive toggle. Trailing Discard actions
 * keep their own tooltips.
 */
export function SourceControlTreeItems({
    activeEditorResource,
    depth = 0,
    expandedDirectories,
    nodes,
    providerKey,
    repositoryRootPath,
    runAction,
    setDirectoriesExpanded,
}: {
    activeEditorResource?: string;
    depth?: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    nodes: SourceControlTreeNode[];
    providerKey: string;
    repositoryRootPath?: string;
    runAction: (action: SourceControlAction) => void;
    setDirectoriesExpanded: (keys: readonly string[], isExpanded: boolean) => void;
}) {
    return nodes.map((node) => {
        if (node.kind === 'directory') {
            const expansionKey = `${providerKey}:${node.path}`;
            const isExpanded = expandedDirectories[expansionKey] ?? true;
            return (
                <div key={node.path}>
                    <SourceControlTreeRow
                        rowId={`directory:${providerKey}:${node.path}`}
                        level={3 + depth}
                        className="git-tree-directory flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-surface pr-2 text-left text-foreground hover:bg-elevated"
                        style={{ paddingLeft: 8 + depth * 14 }}
                        aria-expanded={isExpanded}
                        aria-keyshortcuts="Alt"
                        data-path={node.path}
                        onClick={(event) =>
                            setDirectoriesExpanded(
                                event.altKey
                                    ? sourceControlDirectoryExpansionKeys(node, providerKey)
                                    : [expansionKey],
                                !isExpanded,
                            )
                        }
                        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                            if (event.key !== 'Enter' || !event.altKey) return;
                            event.preventDefault();
                            setDirectoriesExpanded(
                                sourceControlDirectoryExpansionKeys(node, providerKey),
                                !isExpanded,
                            );
                        }}
                    >
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <FileTypeIcon
                            entry={{ kind: 'directory', name: node.name }}
                            expanded={isExpanded}
                        />
                        <span className="truncate">{node.name}</span>
                    </SourceControlTreeRow>
                    {isExpanded && (
                        <SourceControlTreeItems
                            activeEditorResource={activeEditorResource}
                            depth={depth + 1}
                            expandedDirectories={expandedDirectories}
                            nodes={node.children}
                            providerKey={providerKey}
                            repositoryRootPath={repositoryRootPath}
                            runAction={runAction}
                            setDirectoriesExpanded={setDirectoriesExpanded}
                        />
                    )}
                </div>
            );
        }
        const resource = node.resource;
        const trailingActions = resource.actions ?? [];
        const resourcePath = resolveRepoFilePath(repositoryRootPath, resource.path);
        /**
         * A deleted path has no working-tree file left to open, so it keeps the plain diff activation only.
         */
        const openablePath =
            resource.decoration?.identifier === 'deleted' ? undefined : resourcePath;
        const onResourceClick = (event: MouseEvent<HTMLButtonElement>): void => {
            if (openablePath && event.altKey) {
                // `openFile` (not `openEditorTab`) reads the file first and only creates the tab on
                // success, so a path that vanished since the last refresh toasts instead of leaving
                // a tab stuck on "Loading file…".
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void openFile(openablePath);
                return;
            }
            if (resource.action) runAction(resource.action);
        };
        return (
            <div key={resource.id} className="git-row-container group relative">
                <SourceControlTreeRow
                    rowId={`resource:${resource.id}`}
                    level={3 + depth}
                    menuItems={sourceControlActionMenuItems(trailingActions, runAction)}
                    className={cn(
                        resourceRowClassName,
                        'hover:bg-elevated',
                        activeEditorResource === resource.editorResource && 'active bg-elevated',
                    )}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    data-path={resource.path}
                    aria-label={resource.accessibilityLabel}
                    aria-keyshortcuts={openablePath ? 'Alt' : undefined}
                    draggable={Boolean(resourcePath)}
                    onDragStart={(event) => handleResourceDragStart(event, resourcePath)}
                    onClick={onResourceClick}
                >
                    <SourceControlIcon icon={resource.icon} />
                    <span
                        className={cn('min-w-0 flex-1 truncate', resourceColorClassName(resource))}
                    >
                        {node.name}
                    </span>
                    <Decoration
                        resource={resource}
                        className={
                            trailingActions.length > 0
                                ? 'group-focus-within:invisible group-hover:invisible'
                                : undefined
                        }
                    />
                </SourceControlTreeRow>
                {trailingActions.map((action, index) => (
                    <Tooltip content={action.tooltip ?? action.label} key={action.id}>
                        <Button
                            className={
                                index === 0
                                    ? 'git-discard-file absolute top-1/2 right-1 hidden size-5 -translate-y-1/2 group-focus-within:flex group-hover:flex'
                                    : 'git-discard-file absolute top-1/2 hidden size-5 -translate-y-1/2 group-focus-within:flex group-hover:flex'
                            }
                            style={index === 0 ? undefined : { right: 4 + index * 20 }}
                            size="icon"
                            variant="ghost"
                            tabIndex={-1}
                            aria-label={action.accessibilityLabel ?? action.label}
                            disabled={action.disabled}
                            onClick={() => runAction(action)}
                        >
                            <SourceControlIcon icon={action.icon} />
                        </Button>
                    </Tooltip>
                ))}
            </div>
        );
    });
}
