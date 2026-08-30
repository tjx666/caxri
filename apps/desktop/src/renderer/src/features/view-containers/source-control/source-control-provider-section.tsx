import { useState } from 'react';

import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { Button } from '../../../components/ui/button';
import { Empty } from '../../../components/ui/empty';
import { Tooltip } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utilities';
import type { SourceControlController } from './hooks/use-source-control-controller';
import { SourceControlHistory } from './source-control-history';
import { SourceControlIcon } from './source-control-icon';
import { buildSourceControlResourceTree } from './source-control-tree';
import { SourceControlTreeItems } from './source-control-tree-items';

type ReadyController = Extract<SourceControlController, { status: 'ready' }>;
type ProviderModel = SourceControlViewModel['providers'][number];
type GroupModel = ProviderModel['groups'][number];

function ProviderHeader({
    controller,
    expanded,
    provider,
}: {
    controller: ReadyController;
    expanded: boolean;
    provider: ProviderModel;
}) {
    const [runningActionId, setRunningActionId] = useState<string>();
    const run = async (action_: SourceControlAction): Promise<void> => {
        if (runningActionId) return;
        setRunningActionId(action_.id);
        try {
            await controller.runAction(action_);
        } finally {
            setRunningActionId(undefined);
        }
    };
    return (
        <div className="git-repository-header group flex items-center bg-surface hover:bg-elevated">
            <button
                className="git-repository-row flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden border-0 bg-transparent p-2 text-left text-foreground"
                aria-expanded={expanded}
                title={provider.tooltip}
                onClick={() => controller.setProviderExpanded(provider.id, !expanded)}
            >
                <span className="git-repository-identity flex shrink-0 items-center gap-1">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <SourceControlIcon icon={provider.icon} size={12} />
                    <strong className="git-repository-name shrink-0 font-semibold whitespace-nowrap">
                        {provider.label}
                    </strong>
                    {provider.kindLabel && (
                        <small className="git-repository-kind shrink-0 text-[11px] whitespace-nowrap text-muted">
                            {provider.kindLabel}
                        </small>
                    )}
                </span>
                <span
                    className="git-repository-meta flex min-w-0 flex-1 items-center justify-end gap-1 text-[11px] text-muted"
                    aria-label={provider.descriptionAccessibilityLabel}
                    title={provider.descriptionTooltip}
                >
                    <span className="git-repository-branch min-w-0 truncate">
                        {provider.description}
                    </span>
                    <span className="git-repository-counts shrink-0 whitespace-nowrap">
                        {provider.countLabel}
                    </span>
                </span>
            </button>
            {provider.actions.map((action) => {
                const isRunning = runningActionId === action.id;
                return (
                    <Tooltip content={action.tooltip ?? action.label} key={action.id}>
                        <Button
                            className="git-sync mr-1 flex size-6 flex-none"
                            size="icon"
                            variant="ghost"
                            aria-label={
                                isRunning
                                    ? (action.progressLabel ??
                                      action.accessibilityLabel ??
                                      action.label)
                                    : (action.accessibilityLabel ?? action.label)
                            }
                            aria-busy={isRunning || undefined}
                            disabled={action.disabled === true || runningActionId !== undefined}
                            onClick={() => {
                                // eslint-disable-next-line no-void -- run owns progress and the controller owns errors
                                void run(action);
                            }}
                        >
                            <SourceControlIcon
                                className={
                                    isRunning
                                        ? 'animate-spin motion-reduce:animate-none'
                                        : undefined
                                }
                                icon={action.icon}
                            />
                            {isRunning && action.progressLabel && (
                                <span className="sr-only" role="status" aria-live="polite">
                                    {action.progressLabel}
                                </span>
                            )}
                        </Button>
                    </Tooltip>
                );
            })}
        </div>
    );
}

function GroupCaption({
    controller,
    expanded,
    group,
}: {
    controller: ReadyController;
    expanded: boolean;
    group: GroupModel;
}) {
    return (
        <div className="git-changes-caption flex items-center justify-between pr-2 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
            <button
                type="button"
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                aria-expanded={expanded}
                onClick={() => controller.setGroupExpanded(group.id, !expanded)}
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="truncate">{group.label}</span>
            </button>
            <span className="git-changes-actions flex items-center gap-1">
                {group.actions.map((action) => (
                    <Tooltip content={action.tooltip ?? action.label} key={action.id}>
                        <Button
                            className={cn(
                                'size-6',
                                action.emphasis === 'danger'
                                    ? 'git-discard-all'
                                    : 'git-open-changes',
                            )}
                            size="icon"
                            variant="ghost"
                            aria-label={action.accessibilityLabel ?? action.label}
                            disabled={action.disabled}
                            onClick={() => {
                                // eslint-disable-next-line no-void -- the controller owns provider action errors
                                void controller.runAction(action);
                            }}
                        >
                            <SourceControlIcon icon={action.icon} />
                        </Button>
                    </Tooltip>
                ))}
                <span>{group.count}</span>
            </span>
        </div>
    );
}

export function SourceControlProviderSection({
    controller,
    provider,
}: {
    controller: ReadyController;
    provider: ProviderModel;
}) {
    const reduceMotion = useShouldReduceMotion();
    const expanded =
        controller.navigation.expandedProviders[provider.id] ?? provider.expandedByDefault;
    return (
        <section
            className={cn(
                "git-repository-section relative border-b border-border after:pointer-events-none after:absolute after:inset-0 after:z-10 after:bg-accent/10 after:opacity-0 after:content-['']",
                !reduceMotion && 'after:transition-opacity after:duration-500',
                controller.flashedProviderId === provider.id && 'after:opacity-100',
            )}
            data-git-repository-id={provider.id}
        >
            <ProviderHeader controller={controller} expanded={expanded} provider={provider} />
            <DisclosureMotion animate expanded={expanded} kind="git-repository">
                {() => (
                    <div className="git-files overflow-visible">
                        {provider.groups.map((group) => {
                            const groupExpanded =
                                controller.navigation.expandedGroups[group.id] ??
                                group.expandedByDefault;
                            return (
                                <div key={group.id}>
                                    <GroupCaption
                                        controller={controller}
                                        expanded={groupExpanded}
                                        group={group}
                                    />
                                    <DisclosureMotion
                                        animate
                                        expanded={groupExpanded}
                                        kind="git-changes"
                                    >
                                        {() => (
                                            <div className="git-changes-body">
                                                {group.truncationMessage && (
                                                    <div
                                                        role="status"
                                                        aria-live="polite"
                                                        className="git-changes-truncated border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                                                    >
                                                        {group.truncationMessage}
                                                    </div>
                                                )}
                                                {group.resources.length === 0 && (
                                                    <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                                                        {group.emptyMessage}
                                                    </Empty>
                                                )}
                                                {group.resources.length > 0 && (
                                                    <SourceControlTreeItems
                                                        activeEditorResource={
                                                            controller.activeEditorResource
                                                        }
                                                        expandedDirectories={
                                                            controller.navigation
                                                                .expandedDirectories
                                                        }
                                                        nodes={buildSourceControlResourceTree(
                                                            group.resources,
                                                        )}
                                                        providerKey={`${controller.model.selectedModeId}:${provider.id}`}
                                                        runAction={controller.runAction}
                                                        setDirectoriesExpanded={
                                                            controller.setDirectoriesExpanded
                                                        }
                                                    />
                                                )}
                                            </div>
                                        )}
                                    </DisclosureMotion>
                                </div>
                            );
                        })}
                        {provider.history && (
                            <SourceControlHistory
                                descriptor={provider.history}
                                enabled={!controller.isRefreshing}
                                runAction={controller.runAction}
                            />
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
