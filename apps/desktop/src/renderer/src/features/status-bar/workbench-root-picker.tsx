import type { WorkbenchRootOption } from '@caxri/protocol';
import { Check, FolderGit2 } from 'lucide-react';

import { StructuredTooltip } from '../../components/structured-tooltip';
import {
    Command,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Separator } from '../../components/ui/separator';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { WorktreeIcon } from '../../icons/codicons/worktree-icon';
import { cn } from '../../lib/utilities';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { useWorkbenchRootPicker } from './hooks/use-workbench-root-picker';
import { PickerQueryStatus } from './picker-query-status';
import { pickerSearchScore } from './picker-search';
import { statusItemClassName } from './status-item';
import {
    conversationWorkbenchRoots,
    visibleWorkbenchRoots,
    workbenchRootLabel,
} from './workbench-root-options';

function WorktreeOption({
    root,
    roots,
    current,
    disabled,
    onSelect,
}: {
    root: WorkbenchRootOption;
    roots: WorkbenchRootOption[];
    current: boolean;
    disabled: boolean;
    onSelect: () => void;
}) {
    const { t } = useTranslation();
    const label = workbenchRootLabel(root, roots, t);
    const authorization =
        root.authorization === 'required' ? t('statusBar.workbenchRoot.authorize') : '';
    const mainWorktree = t('statusBar.workbenchRoot.mainWorktree');
    return (
        <Tooltip
            content={
                <StructuredTooltip
                    title={label}
                    rows={[
                        {
                            label: t('statusBar.workbenchRoot.path'),
                            value: root.rootPath,
                            isCode: true,
                        },
                    ]}
                />
            }
        >
            <CommandItem
                value={root.worktreeId}
                keywords={[root.branch, root.displayTitle, root.rootPath]}
                aria-label={[label, authorization, root.isMain ? mainWorktree : '']
                    .filter(Boolean)
                    .join(t('statusBar.listSeparator'))}
                disabled={disabled}
                onSelect={onSelect}
                className="items-center text-[13px]"
            >
                <Check
                    size={13}
                    className={cn('flex-none', !current && 'invisible')}
                    aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {root.isMain && (
                    <span className="flex-none text-[11px] text-muted">{mainWorktree}</span>
                )}
                {authorization && (
                    <span className="flex-none text-[11px] text-muted">{authorization}</span>
                )}
            </CommandItem>
        </Tooltip>
    );
}

/**
 * The recommended group and the ordinary list render identical rows; only their membership differs, so they share one
 * mapper rather than two copies that can drift apart.
 */
function WorktreeOptions({
    options,
    roots,
    currentProjectId,
    picker,
}: {
    options: readonly WorkbenchRootOption[];
    roots: WorkbenchRootOption[];
    currentProjectId: string;
    picker: ReturnType<typeof useWorkbenchRootPicker>;
}) {
    return options.map((root) => (
        <WorktreeOption
            key={root.worktreeId}
            root={root}
            roots={roots}
            current={root.projectId === currentProjectId}
            disabled={picker.switching}
            onSelect={() => {
                // eslint-disable-next-line no-void -- the action owns its error toast and pending state.
                void picker.select(root);
            }}
        />
    ));
}

/**
 * The status bar chip that opens the menu.
 *
 * `isWorktree` decides the glyph: VS Code's `worktree` codicon for a Session working in a linked worktree. `FolderGit2`
 * stays for the ordinary case, where it still means "Workbench Root".
 */
function WorkbenchRootTrigger({
    branch,
    isExpanded,
    isSwitching,
    switchingLabel,
    isWorktree,
    title,
    rootPath,
}: {
    branch: string;
    isExpanded: boolean;
    isSwitching: boolean;
    switchingLabel: string;
    isWorktree: boolean;
    title: string;
    rootPath: string;
}) {
    const { t } = useTranslation();
    const switchingText = t('statusBar.workbenchRoot.switching', { name: switchingLabel });
    return (
        <Tooltip
            content={
                isSwitching ? (
                    switchingText
                ) : (
                    <StructuredTooltip
                        eyebrow={t(
                            isWorktree
                                ? 'statusBar.workbenchRoot.linkedWorktree'
                                : 'statusBar.workbenchRoot.workbenchRoot',
                        )}
                        title={title}
                        rows={[
                            { label: t('statusBar.workbenchRoot.branch'), value: branch },
                            {
                                label: t('statusBar.workbenchRoot.path'),
                                value: rootPath,
                                isCode: true,
                            },
                        ]}
                        hint={t('statusBar.workbenchRoot.hint')}
                    />
                )
            }
            // The pointer is still on the trigger once its menu opens, so a hover delay that fires after the click
            // would raise the tooltip over the menu's first options and swallow the click meant for them.
            disabled={isExpanded}
        >
            <PopoverTrigger
                role="combobox"
                aria-expanded={isExpanded}
                aria-haspopup="listbox"
                aria-disabled={isSwitching}
                aria-busy={isSwitching}
                aria-label={
                    isSwitching
                        ? switchingText
                        : t('statusBar.workbenchRoot.switchFrom', { title, branch })
                }
                className={cn(
                    statusItemClassName,
                    // Capped rather than shrinking, so the bar can measure its natural width (`chip-priority.ts`).
                    'h-5 w-auto max-w-60 flex-none justify-start px-[5px] text-[11px]',
                )}
            >
                {isSwitching ? (
                    <Spinner size={13} />
                ) : isWorktree ? (
                    <WorktreeIcon size={13} className="flex-none" />
                ) : (
                    <FolderGit2 size={13} className="flex-none" />
                )}
                <span className="min-w-0 truncate" role={isSwitching ? 'status' : undefined}>
                    {isSwitching ? switchingText : title}
                </span>
            </PopoverTrigger>
        </Tooltip>
    );
}

interface WorkbenchRootPickerProperties {
    branch?: string;
    sessionId: string;
}

function WorkbenchRootPickerContent({ branch, sessionId }: WorkbenchRootPickerProperties) {
    const { t } = useTranslation();
    const session = useSelectedSession();
    const workbenchProject = useSelectedWorkbenchProject();
    const picker = useWorkbenchRootPicker(sessionId);
    if (!session || !workbenchProject) return null;
    const roots = picker.rootsQuery.data ?? [];
    const current = roots.find((root) => root.projectId === session.workbenchProjectId);
    // Typing searches every root: the compact list exists to keep the closed menu short, not to
    // hide worktrees from a query the user already typed.
    const isSearching = picker.search.trim().length > 0;
    // The recommendations are a shortcut for the closed menu. Once the user types, the flat list of matches is the
    // better answer, so the group folds back into the ordinary list rather than splitting the results in two.
    const recommended = isSearching ? [] : conversationWorkbenchRoots(roots);
    const visible = visibleWorkbenchRoots(
        roots,
        session.workbenchProjectId,
        picker.all || isSearching,
        new Set(recommended.map((root) => root.worktreeId)),
    );
    return (
        <Popover open={picker.open} onOpenChange={picker.changeOpen}>
            <WorkbenchRootTrigger
                branch={branch ?? current?.branch ?? t('statusBar.workbenchRoot.noBranch')}
                isExpanded={picker.open}
                isSwitching={picker.switching}
                switchingLabel={picker.switchingLabel}
                isWorktree={workbenchProject.id !== session.projectId}
                title={workbenchProject.displayTitle}
                rootPath={workbenchProject.rootPath}
            />
            <PopoverContent
                side="top"
                className="w-96 max-w-[calc(100vw-16px)]"
                aria-label={t('statusBar.workbenchRoot.dialogLabel')}
            >
                <Command
                    key={picker.all ? 'all' : 'recent'}
                    // `cmdk` points the input's `aria-labelledby` at this label, and
                    // `aria-labelledby` outranks `aria-label`, so this string (not a prop on
                    // `CommandInput`) is the search field's accessible name. The popup keeps
                    // `Workbench Roots` as its own dialog name above.
                    label={t('statusBar.workbenchRoot.searchLabel')}
                    defaultValue={current?.worktreeId}
                    filter={pickerSearchScore}
                >
                    <CommandInput
                        autoFocus
                        value={picker.search}
                        onValueChange={picker.setSearch}
                        placeholder={t('statusBar.workbenchRoot.searchPlaceholder')}
                    />
                    <CommandList className="max-h-[min(360px,var(--available-height))]">
                        <PickerQueryStatus noun="worktrees" query={picker.rootsQuery} />
                        {recommended.length > 0 && (
                            <>
                                <CommandGroup heading={t('statusBar.source.conversation')}>
                                    <WorktreeOptions
                                        options={recommended}
                                        roots={roots}
                                        currentProjectId={session.workbenchProjectId}
                                        picker={picker}
                                    />
                                </CommandGroup>
                                <Separator className="my-1" />
                            </>
                        )}
                        <WorktreeOptions
                            options={visible}
                            roots={roots}
                            currentProjectId={session.workbenchProjectId}
                            picker={picker}
                        />
                        {!picker.all &&
                            !isSearching &&
                            visible.length + recommended.length < roots.length && (
                                <>
                                    <Separator className="my-1" />
                                    <CommandItem
                                        value="show-all-worktrees"
                                        className="text-[13px]"
                                        onSelect={() => picker.setAll(true)}
                                    >
                                        {t('statusBar.workbenchRoot.showAll')}
                                        <span className="text-muted">{roots.length}</span>
                                    </CommandItem>
                                </>
                            )}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

/**
 * Resets pending menu state when the selected Session changes.
 */
export function WorkbenchRootPicker(properties: WorkbenchRootPickerProperties) {
    return <WorkbenchRootPickerContent key={properties.sessionId} {...properties} />;
}
