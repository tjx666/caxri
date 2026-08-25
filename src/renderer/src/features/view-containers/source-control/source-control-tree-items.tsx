import type { SourceControlAction, SourceControlResource } from '@shared/views';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import { cn } from '../../../lib/utilities';
import { SourceControlIcon } from './source-control-icon';
import type { SourceControlTreeNode } from './source-control-tree';

const resourceRowClassName =
    'git-row flex w-full items-center gap-2 h-7 px-2 border-0 bg-surface text-left cursor-pointer';

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
                value.tone === 'warning' && 'text-warning',
                value.tone === 'success' && 'text-success',
                value.tone === 'danger' && 'text-danger',
                className,
            )}
        >
            {value.label}
        </span>
    );
}

export function SourceControlTreeItems({
    activeEditorResource,
    depth = 0,
    expandedDirectories,
    nodes,
    providerKey,
    runAction,
    setDirectoryExpanded,
}: {
    activeEditorResource?: string;
    depth?: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    nodes: SourceControlTreeNode[];
    providerKey: string;
    runAction: (action: SourceControlAction) => void;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
}) {
    return nodes.map((node) => {
        if (node.kind === 'directory') {
            const expansionKey = `${providerKey}:${node.path}`;
            const isExpanded = expandedDirectories[expansionKey] ?? true;
            return (
                <div key={node.path}>
                    <button
                        className="git-tree-directory flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-surface pr-2 text-left text-foreground hover:bg-elevated"
                        style={{ paddingLeft: 8 + depth * 14 }}
                        aria-expanded={isExpanded}
                        title={node.path}
                        onClick={() => setDirectoryExpanded(expansionKey, !isExpanded)}
                    >
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <FileTypeIcon
                            entry={{ kind: 'directory', name: node.name }}
                            expanded={isExpanded}
                        />
                        <span className="truncate">{node.name}</span>
                    </button>
                    <DisclosureMotion animate expanded={isExpanded} kind="git-directory">
                        {() => (
                            <SourceControlTreeItems
                                activeEditorResource={activeEditorResource}
                                depth={depth + 1}
                                expandedDirectories={expandedDirectories}
                                nodes={node.children}
                                providerKey={providerKey}
                                runAction={runAction}
                                setDirectoryExpanded={setDirectoryExpanded}
                            />
                        )}
                    </DisclosureMotion>
                </div>
            );
        }
        const resource = node.resource;
        const trailingActions = resource.actions ?? [];
        if (resource.navigationTargetId && trailingActions.length === 0)
            return (
                <button
                    key={resource.id}
                    className={cn(resourceRowClassName, 'git-submodule-row hover:bg-elevated')}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    title={resource.tooltip}
                    aria-label={resource.accessibilityLabel}
                    onClick={() => resource.action && runAction(resource.action)}
                >
                    <SourceControlIcon className="shrink-0" icon={resource.icon} size={14} />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {resource.description && (
                        <small className="shrink-0 text-[11px] whitespace-nowrap text-muted">
                            {resource.description}
                        </small>
                    )}
                    <Decoration resource={resource} />
                </button>
            );
        if (resource.navigationTargetId)
            return (
                <div key={resource.id} className="git-row-container group relative">
                    <button
                        className={cn(resourceRowClassName, 'git-submodule-row hover:bg-elevated')}
                        style={{ paddingLeft: 10 + depth * 14 }}
                        title={resource.tooltip}
                        aria-label={resource.accessibilityLabel}
                        onClick={() => resource.action && runAction(resource.action)}
                    >
                        <SourceControlIcon className="shrink-0" icon={resource.icon} size={14} />
                        <span className="min-w-0 flex-1 truncate">{node.name}</span>
                        {resource.description && (
                            <small className="shrink-0 text-[11px] whitespace-nowrap text-muted">
                                {resource.description}
                            </small>
                        )}
                        <Decoration resource={resource} />
                    </button>
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
        return (
            <div key={resource.id} className="git-row-container group relative">
                <button
                    className={cn(
                        resourceRowClassName,
                        'hover:bg-elevated',
                        activeEditorResource === resource.editorResource && 'active bg-elevated',
                    )}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    title={resource.tooltip}
                    aria-label={resource.accessibilityLabel}
                    onClick={() => resource.action && runAction(resource.action)}
                >
                    <SourceControlIcon icon={resource.icon} />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    <Decoration
                        resource={resource}
                        className={
                            trailingActions.length > 0
                                ? 'group-focus-within:invisible group-hover:invisible'
                                : undefined
                        }
                    />
                </button>
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
