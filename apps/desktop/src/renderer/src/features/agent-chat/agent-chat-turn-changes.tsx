import { useId, useMemo, useState } from 'react';

import type { AgentChatEditedFile } from '@caxri/protocol';
import {
    agentChatEditedFileLines,
    agentChatEditedFilesStat,
    projectDisplayPath,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { ChevronDown, FileDiff, LoaderCircle, MessageSquareDiff, Undo2 } from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { Button } from '../../components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { parentDirectoryPath } from '../../lib/file-path';
import { cn } from '../../lib/utilities';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { agentChatLocalizedEditedFilesTitle } from './agent-chat-diff-labels';
import { AgentChatDiff } from './agent-chat-file-changes';
import { openAgentChatTurnReview } from './agent-chat-task-opener';
import {
    agentChatUndoKey,
    undoAgentChatTurn,
    useAgentChatUndoStore,
} from './agent-chat-undo-commands';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';

/**
 * One file's diff across the turn, under a header naming it with its counts. The hover preview and an expanded row
 * share it.
 */
function EditedFileDiff({ file, label }: { file: AgentChatEditedFile; label?: string }) {
    const lines = useMemo(() => agentChatEditedFileLines(file), [file]);
    return (
        <div>
            {label && (
                <div className="flex h-8 items-center gap-2 border-b border-border px-3 text-[12px]">
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <DiffStat additions={file.additions} deletions={file.deletions} />
                </div>
            )}
            {/* Diff text is content in an otherwise `select-none` transcript; its gutters stay unselectable. */}
            <div className="bg-background select-text">
                <AgentChatDiff lines={lines} truncated={file.truncated} />
            </div>
        </div>
    );
}

/**
 * One changed file in a multi-file card: its directory in `--muted` and its name in the text color, the Codex app's
 * row, with its counts at the end. Clicking it discloses the file's diff.
 */
function EditedFileRow({
    displayPath,
    file,
    isExpanded,
    onToggle,
}: {
    displayPath: string;
    file: AgentChatEditedFile;
    isExpanded: boolean;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    const detailId = useId();
    const directory = parentDirectoryPath(displayPath);
    return (
        <li className="border-t border-border">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                aria-label={t(
                    isExpanded
                        ? 'agentChat.changes.hideFileChanges'
                        : 'agentChat.changes.showFileChanges',
                    { path: displayPath, stat: diffStatLabel(file, t) },
                )}
                className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-3 text-left text-[12px] hover:bg-elevated focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-accent"
                type="button"
                onClick={onToggle}
            >
                <span className="min-w-0 flex-1 truncate">
                    {directory && <span className="text-muted">{directory}/</span>}
                    <span className="text-foreground">{pathBasename(displayPath)}</span>
                </span>
                <DiffStat additions={file.additions} deletions={file.deletions} />
            </button>
            <DisclosureMotion
                animate
                expanded={isExpanded}
                id={detailId}
                kind="agent-chat-file-change"
            >
                <div className="border-t border-border">
                    <EditedFileDiff file={file} />
                </div>
            </DisclosureMotion>
        </li>
    );
}

/**
 * The files a finished turn changed, as the Codex app ends a turn: a glyph tile, `Edited app.ts` or `Edited 3 files`
 * over the turn's `+N -M`, Undo, and Review. The counts, with a disclosure chevron, are the card's one inline toggle:
 * hovered or focused they turn into `View changes` (or `Hide changes`) and preview the diff in a hover card, and a
 * click discloses every diff in place. No external-arrow glyph, since nothing leaves the Chat. More than one file lists
 * each under the header, and a row discloses its own diff. Review, labeled because it is the one action that opens
 * something else, shows the whole turn as one diff in a side tab where its lines can be commented on.
 */
export function AgentChatTurnChanges({
    files,
    isPartial,
    turnId,
}: {
    files: readonly AgentChatEditedFile[];
    /**
     * The Chat dropped the start of this turn, so `files` is incomplete and Undo is withheld.
     */
    isPartial: boolean;
    turnId: string;
}) {
    const { t } = useTranslation();
    const session = usePaneViewSession();
    const terminalId = useAgentChatTerminal();
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const detailId = useId();
    const undoStatus = useAgentChatUndoStore((state) =>
        session ? state.turns[agentChatUndoKey(session.id, turnId)] : undefined,
    );
    const displayPath = (path: string): string => projectDisplayPath(path, session?.rootPath);
    const stat = agentChatEditedFilesStat(files);
    const title = agentChatLocalizedEditedFilesTitle(files, t);
    const isAllExpanded = files.every((file) => expanded.has(file.path));
    /**
     * The hover preview only stands in for the diffs while they are hidden. A click on the counts discloses them in
     * place, so it also closes the preview, which would otherwise cover the cards below until the pointer leaves.
     */
    const [isPreviewOpen, setPreviewOpen] = useState(false);
    const toggleAll = (): void => {
        setPreviewOpen(false);
        setExpanded(isAllExpanded ? new Set() : new Set(files.map((file) => file.path)));
    };
    const toggle = (path: string): void =>
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(path)) next.add(path);
            return next;
        });
    const undoBlocker = isPartial
        ? 'agentChat.undo.partialTurnTooltip'
        : files.some((file) => file.truncated)
          ? 'agentChat.undo.truncatedTooltip'
          : undefined;
    const only = files.at(0);
    const sessionId = session?.id;
    return (
        <div
            className="overflow-hidden rounded-lg border border-border bg-surface"
            data-agent-chat-turn-changes=""
        >
            <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                    <FileDiff aria-hidden="true" className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] leading-5 text-foreground">{title}</div>
                    <HoverCard open={isPreviewOpen && !isAllExpanded} onOpenChange={setPreviewOpen}>
                        <HoverCardTrigger
                            closeDelay={120}
                            delay={350}
                            render={
                                <button
                                    aria-controls={files.length === 1 ? detailId : undefined}
                                    aria-expanded={isAllExpanded}
                                    aria-label={t(
                                        isAllExpanded
                                            ? 'agentChat.changes.hideAllWithStat'
                                            : 'agentChat.changes.viewAllWithStat',
                                        { stat: diffStatLabel(stat, t) },
                                    )}
                                    className="group/stat flex h-5 cursor-pointer items-center border-0 bg-transparent p-0 text-[12px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                                    type="button"
                                    onClick={toggleAll}
                                />
                            }
                        >
                            <DiffStat
                                additions={stat.additions}
                                className="group-hover/stat:hidden group-focus-visible/stat:hidden"
                                deletions={stat.deletions}
                            />
                            <span className="hidden group-hover/stat:inline group-focus-visible/stat:inline">
                                {t(
                                    isAllExpanded
                                        ? 'agentChat.changes.hideChanges'
                                        : 'agentChat.changes.viewChanges',
                                )}
                            </span>
                            {/* Always shown, so the counts read as a disclosure before the pointer finds them. */}
                            <ChevronDown
                                aria-hidden="true"
                                className={cn(
                                    'ml-1 size-3.5 transition-transform duration-(--motion-expand) ease-(--motion-ease-emphasized) motion-reduce:transition-none',
                                    isAllExpanded && 'rotate-180',
                                )}
                            />
                        </HoverCardTrigger>
                        <HoverCardContent
                            align="start"
                            className="max-h-96 w-[min(40rem,var(--available-width))] overflow-auto p-0"
                            side="bottom"
                        >
                            {files.map((file) => (
                                <EditedFileDiff
                                    file={file}
                                    key={file.path}
                                    label={displayPath(file.path)}
                                />
                            ))}
                        </HoverCardContent>
                    </HoverCard>
                </div>
                {sessionId !== undefined &&
                    (undoStatus === 'undone' ? (
                        <span className="shrink-0 text-[12px] text-muted">
                            {t('agentChat.undo.undone')}
                        </span>
                    ) : (
                        <Tooltip content={t(undoBlocker ?? 'agentChat.undo.tooltip')}>
                            <Button
                                aria-disabled={
                                    undoBlocker !== undefined || undoStatus === 'undoing'
                                }
                                className="shrink-0 gap-1 text-[12px] text-muted enabled:not-aria-disabled:hover:text-foreground"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    if (undoBlocker !== undefined || undoStatus === 'undoing')
                                        return;
                                    // eslint-disable-next-line no-void -- undoAgentChatTurn reports failures through tryCommand
                                    void undoAgentChatTurn({
                                        sessionId,
                                        turnId,
                                        files,
                                        displayPath,
                                    });
                                }}
                            >
                                {t('agentChat.undo.button')}
                                {undoStatus === 'undoing' ? (
                                    <LoaderCircle
                                        aria-hidden="true"
                                        className="size-3.5 motion-safe:animate-spin"
                                    />
                                ) : (
                                    <Undo2 aria-hidden="true" className="size-3.5" />
                                )}
                            </Button>
                        </Tooltip>
                    ))}
                {terminalId !== undefined && (
                    <Tooltip content={t('agentChat.review.tooltip')}>
                        <Button
                            className="shrink-0 gap-1 text-[12px]"
                            size="sm"
                            variant="secondary"
                            onClick={() => openAgentChatTurnReview(terminalId, turnId)}
                        >
                            <MessageSquareDiff aria-hidden="true" className="size-3.5" />
                            {t('agentChat.review.button')}
                        </Button>
                    </Tooltip>
                )}
            </div>
            {files.length > 1 ? (
                <ul className="m-0 list-none p-0">
                    {files.map((file) => (
                        <EditedFileRow
                            displayPath={displayPath(file.path)}
                            file={file}
                            isExpanded={expanded.has(file.path)}
                            key={file.path}
                            onToggle={() => toggle(file.path)}
                        />
                    ))}
                </ul>
            ) : (
                only && (
                    <DisclosureMotion
                        animate
                        expanded={expanded.has(only.path)}
                        id={detailId}
                        kind="agent-chat-file-change"
                    >
                        <div className="border-t border-border">
                            <EditedFileDiff file={only} />
                        </div>
                    </DisclosureMotion>
                )
            )}
        </div>
    );
}
