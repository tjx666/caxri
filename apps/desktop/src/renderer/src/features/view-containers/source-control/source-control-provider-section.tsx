import type { KeyboardEvent, ReactNode } from 'react';
import { useState } from 'react';

import type {
    SourceControlAction,
    SourceControlExternalLink,
    SourceControlViewModel,
} from '@caxri/protocol';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';

import { DiffStat } from '../../../components/diff-stat';
import { DisclosureMotion } from '../../../components/disclosure-motion';
import type { StructuredTooltipData } from '../../../components/structured-tooltip';
import { StructuredTooltip } from '../../../components/structured-tooltip';
import { Button } from '../../../components/ui/button';
import { Empty } from '../../../components/ui/empty';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { diffStatLabel } from '../../../lib/diff-stat-label';
import { openExternalUrl } from '../../../lib/external-link';
import { cn } from '../../../lib/utilities';
import { pushToast } from '../../../stores/toasts';
import type {
    SourceControlController,
    SourceControlSubtreeTarget,
} from './hooks/use-source-control-controller';
import { SourceControlHistory } from './source-control-history';
import { SourceControlIcon } from './source-control-icon';
import type { SourceControlRowMenuItem } from './source-control-row-menu';
import { sourceControlActionMenuItems } from './source-control-row-menu';
import {
    buildSourceControlResourceTree,
    sourceControlGroupExpansionKeys,
    sumSourceControlLineStats,
} from './source-control-tree';
import { SourceControlTreeItems } from './source-control-tree-items';
import { SourceControlTreeRow } from './source-control-tree-row';

type ReadyController = Extract<SourceControlController, { status: 'ready' }>;
type ProviderModel = SourceControlViewModel['providers'][number];
type GroupModel = ProviderModel['groups'][number];

/**
 * Command activation for a row whose primary click already owns disclosure. Returns `true` when the row must not also
 * run its ordinary click behavior, so a caller can keep both gestures on one control. The external page sits on Command
 * rather than Option because Option is the app-wide recursive disclosure gesture, which every collapsible row owes the
 * user (issue #1129); it reads the modifier off a bare shape so a keyboard chord can reuse this path.
 */
function didOpenExternalLink(
    event: { metaKey: boolean },
    link: SourceControlExternalLink | undefined,
): boolean {
    if (!link || !event.metaKey) return false;
    // eslint-disable-next-line no-void -- intentional floating-promise discard; failures surface as a toast
    void openExternalUrl(link.url, (message) => pushToast('error', message));
    return true;
}

/**
 * A disclosure row's hover: what the row is, then the modifier gestures it answers, set apart at the bottom.
 */
function rowTooltip(
    content: Omit<StructuredTooltipData, 'hint'>,
    link: SourceControlExternalLink | undefined,
): ReactNode {
    return (
        <StructuredTooltip
            {...content}
            hint={[
                ...(link ? [`Command-click to ${link.label.toLowerCase()}`] : []),
                'Option-click to expand or collapse everything below',
            ]}
        />
    );
}

/**
 * A provider whose only content is one group — Pull Request and Last Commit modes — folds that group into its own
 * header. The caption repeated what the header and the mode switch already said (`PR #20092 Changes` under a repository
 * row that already counts the same files), and spent a second row per repository on it. Working-tree mode keeps the
 * caption, because there it separates the changes from the history section below.
 */
function foldedGroupOf(provider: ProviderModel): GroupModel | undefined {
    return provider.groups.length === 1 && !provider.history ? provider.groups[0] : undefined;
}

function GroupActionButtons({
    controller,
    group,
}: {
    controller: ReadyController;
    group: GroupModel;
}) {
    return (
        <>
            {group.actions.map((action) => (
                <Tooltip content={action.tooltip ?? action.label} key={action.id}>
                    <Button
                        /*
                         * Revealed on hover or focus, exactly like the single-file toolbar. The group toolbar carries
                         * `Discard All Changes`, which acts on the whole repository; leaving the loudest destructive
                         * action permanently on screen while the narrower one hid behind hover inverted the risk
                         * gradient. VS Code hides both by default and reveals them from one rule (`scm.css`
                         * `.resource-group > .actions` beside `.resource … > .actions`).
                         */
                        className={cn(
                            'hidden size-6 group-focus-within:flex group-hover:flex',
                            action.emphasis === 'danger' ? 'git-discard-all' : 'git-open-changes',
                        )}
                        size="icon"
                        variant="ghost"
                        tabIndex={-1}
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
            {(group.hiddenCount ?? 0) > 0 && (
                <span className="font-normal normal-case">{group.hiddenCount} hidden</span>
            )}
        </>
    );
}

/**
 * The disclosure keys one recursive gesture covers, built only when the gesture happens: `providerKey` mirrors
 * `SourceControlTreeItems`, so it carries the selected mode and two modes never share a folder's disclosure.
 */
function subtreeTarget(
    controller: ReadyController,
    provider: ProviderModel,
    groups: readonly GroupModel[],
    isProviderIncluded: boolean,
): SourceControlSubtreeTarget {
    const providerKey = `${controller.model.selectedModeId}:${provider.id}`;
    return {
        directoryKeys: groups.flatMap((group) =>
            sourceControlGroupExpansionKeys(group.resources, providerKey),
        ),
        groupIds: groups.map((group) => group.id),
        ...(isProviderIncluded && { providerId: provider.id }),
    };
}

function ProviderHeader({
    controller,
    expanded,
    foldedGroup,
    provider,
}: {
    controller: ReadyController;
    expanded: boolean;
    /**
     * The single group this header stands in for; its actions join the header's (see {@link foldedGroupOf}).
     */
    foldedGroup: GroupModel | undefined;
    provider: ProviderModel;
}) {
    const [runningActionId, setRunningActionId] = useState<string>();
    /**
     * The notice borrows the target mode's own icon and switch, so it can never drift from the mode switch it is a
     * shortcut to. A notice naming a mode this provider does not offer renders nothing rather than a dead button.
     */
    const uncommittedMode = controller.model.modes.find(
        (mode) => mode.id === provider.uncommittedNotice?.modeId,
    );
    const run = async (action_: SourceControlAction): Promise<void> => {
        if (runningActionId) return;
        setRunningActionId(action_.id);
        try {
            await controller.runAction(action_);
        } finally {
            setRunningActionId(undefined);
        }
    };
    /**
     * The uncommitted notice joins the row's context menu rather than `provider.actions`, because the protocol
     * deliberately keeps it out of the action registry (`sourceControlProviderSchema.uncommittedNotice`): a mode change
     * dispatched as an action id would give one state change two dispatch paths. Carrying it here is what gives a
     * keyboard user any entry point at all — the inline button is `tabIndex={-1}` like every other inline action in the
     * tree, so `Shift+F10` is how it is reached.
     */
    const menuItems: SourceControlRowMenuItem[] = [
        ...(uncommittedMode && provider.uncommittedNotice
            ? [
                  {
                      id: `${provider.id}:uncommitted-notice`,
                      label: provider.uncommittedNotice.accessibilityLabel,
                      run: () => controller.selectMode(uncommittedMode),
                  },
              ]
            : []),
        ...sourceControlActionMenuItems(provider.actions, (action) => {
            // eslint-disable-next-line no-void -- run owns progress and the controller owns errors
            void run(action);
        }),
        ...(foldedGroup
            ? sourceControlActionMenuItems(foldedGroup.actions, controller.runAction)
            : []),
    ];
    return (
        <div className="git-repository-header group flex items-center bg-surface hover:bg-elevated">
            <SourceControlTreeRow
                rowId={`provider:${provider.id}`}
                level={1}
                className="git-repository-row flex min-w-0 flex-1 cursor-pointer items-center overflow-hidden border-0 bg-transparent px-2 py-1.5 text-left text-foreground"
                aria-expanded={expanded}
                aria-keyshortcuts={provider.externalLink ? 'Meta Alt' : 'Alt'}
                data-path={provider.rootPath}
                tooltip={rowTooltip(
                    {
                        title: provider.label,
                        rows: provider.rootPath
                            ? [{ label: 'Path', value: provider.rootPath, isCode: true }]
                            : undefined,
                        details: [provider.descriptionTooltip],
                        notes:
                            provider.tooltip === provider.rootPath ? undefined : [provider.tooltip],
                    },
                    provider.externalLink,
                )}
                menuItems={menuItems}
                onClick={(event) => {
                    if (didOpenExternalLink(event, provider.externalLink)) return;
                    if (event.altKey) {
                        controller.setSubtreeExpanded(
                            subtreeTarget(controller, provider, provider.groups, true),
                            !expanded,
                        );
                        return;
                    }
                    controller.setProviderExpanded(provider.id, !expanded);
                }}
                onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                    if (event.key !== 'Enter') return;
                    /**
                     * Alt+Enter never reaches a button's click handler, so both modifier gestures need naming here for
                     * a keyboard user — the same pairing the directory rows use.
                     */
                    if (didOpenExternalLink(event, provider.externalLink)) {
                        event.preventDefault();
                        return;
                    }
                    if (!event.altKey) return;
                    event.preventDefault();
                    controller.setSubtreeExpanded(
                        subtreeTarget(controller, provider, provider.groups, true),
                        !expanded,
                    );
                }}
            >
                {/*
                 * One line: the repository identity plus its own counts. The branch is the section's first child row
                 * ({@link ProviderBranchRow}) instead, so a long worktree folder name and a long branch never compete
                 * for the same width, and the header keeps the single-line rhythm of every other row in the tree.
                 */}
                <span className="git-repository-identity flex h-5 min-w-0 flex-1 items-center gap-1 overflow-hidden">
                    {expanded ? (
                        <ChevronDown className="shrink-0" size={13} />
                    ) : (
                        <ChevronRight className="shrink-0" size={13} />
                    )}
                    {/* 14px matches the Project Status tree rows, so the two sidebar panels agree on repository glyph size. */}
                    <SourceControlIcon className="shrink-0" icon={provider.icon} size={14} />
                    <strong className="git-repository-name min-w-0 truncate font-semibold">
                        {provider.label}
                    </strong>
                    {provider.kindLabel && (
                        <small className="git-repository-kind shrink-0 text-[11px] whitespace-nowrap text-muted">
                            {provider.kindLabel}
                        </small>
                    )}
                    {provider.countLabel && (
                        <span className="git-repository-counts shrink-0 text-[11px] whitespace-nowrap text-muted">
                            {provider.countLabel}
                        </span>
                    )}
                </span>
            </SourceControlTreeRow>
            {foldedGroup && (
                <span className="git-changes-actions flex items-center gap-1 text-[11px] text-muted">
                    <GroupActionButtons controller={controller} group={foldedGroup} />
                </span>
            )}
            {uncommittedMode && provider.uncommittedNotice && (
                <Tooltip content={provider.uncommittedNotice.tooltip}>
                    <Button
                        className="git-uncommitted-notice mr-1 flex size-6 flex-none"
                        size="icon"
                        variant="ghost"
                        tabIndex={-1}
                        aria-label={provider.uncommittedNotice.accessibilityLabel}
                        onClick={() => controller.selectMode(uncommittedMode)}
                    >
                        <SourceControlIcon icon={uncommittedMode.icon} />
                    </Button>
                </Tooltip>
            )}
            {provider.actions.map((action) => {
                const isRunning = runningActionId === action.id;
                return (
                    <Tooltip content={action.tooltip ?? action.label} key={action.id}>
                        <Button
                            className="git-sync mr-1 flex size-6 flex-none"
                            size="icon"
                            variant="ghost"
                            tabIndex={-1}
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

/**
 * The repository's branch (or whatever reference the provider describes) as the section's first child row, with the
 * full row width to itself. It carries no action of its own; hovering or focusing it shows the same detail the header
 * tooltip does.
 */
function ProviderBranchRow({ provider }: { provider: ProviderModel }) {
    if (!provider.description) return null;
    return (
        <SourceControlTreeRow
            rowId={`provider-branch:${provider.id}`}
            level={2}
            className="git-repository-branch-row flex h-7 w-full min-w-0 cursor-default items-center gap-1 border-0 bg-transparent px-2 text-left text-[12px] text-muted hover:bg-elevated"
            tooltip={
                <StructuredTooltip
                    title={provider.description}
                    details={[provider.descriptionTooltip]}
                />
            }
        >
            {/* Sits in the chevron column of the group captions below, so the branch text lines up with their labels. */}
            <GitBranch aria-hidden="true" className="shrink-0" size={13} />
            <span
                className="git-repository-meta flex min-w-0 overflow-hidden"
                aria-label={provider.descriptionAccessibilityLabel}
            >
                <span className="git-repository-branch min-w-0 truncate">
                    {provider.description}
                </span>
            </span>
        </SourceControlTreeRow>
    );
}

function GroupCaption({
    controller,
    expanded,
    group,
    provider,
}: {
    controller: ReadyController;
    expanded: boolean;
    group: GroupModel;
    provider: ProviderModel;
}) {
    /**
     * The provider's page for the changes this group lists — the pull request whose number the caption already prints.
     */
    const externalLink = provider.externalLink;
    const toggleRecursively = (): void =>
        controller.setSubtreeExpanded(
            subtreeTarget(controller, provider, [group], false),
            !expanded,
        );
    const lineStats = sumSourceControlLineStats(group.resources.map(({ lineStats }) => lineStats));
    return (
        <div className="git-changes-caption group flex items-center justify-between pr-2 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
            <SourceControlTreeRow
                rowId={`group:${provider.id}:${group.id}`}
                level={2}
                type="button"
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                aria-expanded={expanded}
                aria-keyshortcuts={externalLink ? 'Meta Alt' : 'Alt'}
                aria-description={lineStats && diffStatLabel(lineStats)}
                tooltip={rowTooltip({ title: group.label }, externalLink)}
                menuItems={sourceControlActionMenuItems(group.actions, controller.runAction)}
                onClick={(event) => {
                    if (didOpenExternalLink(event, externalLink)) return;
                    if (event.altKey) {
                        toggleRecursively();
                        return;
                    }
                    controller.setGroupExpanded(group.id, !expanded);
                }}
                onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                    if (event.key !== 'Enter') return;
                    if (didOpenExternalLink(event, externalLink)) {
                        event.preventDefault();
                        return;
                    }
                    if (!event.altKey) return;
                    event.preventDefault();
                    toggleRecursively();
                }}
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="truncate">{group.label}</span>
            </SourceControlTreeRow>
            <span className="git-changes-actions flex items-center gap-1">
                <GroupActionButtons controller={controller} group={group} />
                {lineStats && (
                    <DiffStat
                        {...lineStats}
                        className="mr-1 text-[11px] font-normal tracking-normal normal-case"
                    />
                )}
                <span>{group.count}</span>
            </span>
        </div>
    );
}

/**
 * A group's file list with its truncation notice and empty state. `level` is the ARIA level of its top-level rows: one
 * below the caption, or one below the provider header when the caption is folded away.
 */
function GroupBody({
    controller,
    group,
    level,
    provider,
}: {
    controller: ReadyController;
    group: GroupModel;
    level: number;
    provider: ProviderModel;
}) {
    return (
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
                    {group.isLoading ? (
                        <span className="inline-flex items-center gap-1.5">
                            {/* The Spinner's own "Loading" label would announce alongside the descriptive text below,
                            so it is hidden from assistive tech and the live region announces once. */}
                            <Spinner size={12} aria-hidden="true" />
                            <span role="status" aria-live="polite">
                                {group.emptyMessage}
                            </span>
                        </span>
                    ) : (
                        group.emptyMessage
                    )}
                </Empty>
            )}
            {group.resources.length > 0 && (
                <SourceControlTreeItems
                    activeEditorResource={controller.activeEditorResource}
                    expandedDirectories={controller.navigation.expandedDirectories}
                    level={level}
                    nodes={buildSourceControlResourceTree(group.resources)}
                    providerKey={`${controller.model.selectedModeId}:${provider.id}`}
                    repositoryRootPath={provider.rootPath}
                    runAction={controller.runAction}
                    setDirectoriesExpanded={controller.setDirectoriesExpanded}
                />
            )}
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
    const expanded =
        controller.navigation.expandedProviders[provider.id] ?? provider.expandedByDefault;
    const foldedGroup = foldedGroupOf(provider);
    return (
        <section
            className="git-repository-section relative border-b border-border"
            data-git-repository-id={provider.id}
        >
            <ProviderHeader
                controller={controller}
                expanded={expanded}
                foldedGroup={foldedGroup}
                provider={provider}
            />
            <DisclosureMotion animate expanded={expanded} kind="git-repository">
                {() => (
                    <div className="git-files overflow-visible">
                        <ProviderBranchRow provider={provider} />
                        {foldedGroup ? (
                            <GroupBody
                                controller={controller}
                                group={foldedGroup}
                                level={2}
                                provider={provider}
                            />
                        ) : (
                            provider.groups.map((group) => {
                                const groupExpanded =
                                    controller.navigation.expandedGroups[group.id] ??
                                    group.expandedByDefault;
                                return (
                                    <div key={group.id}>
                                        <GroupCaption
                                            controller={controller}
                                            expanded={groupExpanded}
                                            group={group}
                                            provider={provider}
                                        />
                                        <DisclosureMotion
                                            animate
                                            expanded={groupExpanded}
                                            kind="git-changes"
                                        >
                                            {() => (
                                                <GroupBody
                                                    controller={controller}
                                                    group={group}
                                                    level={3}
                                                    provider={provider}
                                                />
                                            )}
                                        </DisclosureMotion>
                                    </div>
                                );
                            })
                        )}
                        {provider.history && (
                            <SourceControlHistory
                                descriptor={provider.history}
                                enabled={!controller.isRefreshing}
                                level={2}
                                rowIdPrefix={`history:${provider.id}`}
                                runAction={controller.runAction}
                            />
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
