import { useId, useMemo, useState } from 'react';

import type { AgentChatEditedFile } from '@caxri/protocol';
import {
    agentChatEditedFileLines,
    agentChatEditedFilesStat,
    projectDisplayPath,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { ChevronDown, FileDiff, FileSymlink, MessageSquareDiff } from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { Button } from '../../components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { parentDirectoryPath } from '../../lib/file-path';
import { cn } from '../../lib/utilities';
import { openFileForSession } from '../editor/document-commands';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { agentChatLocalizedEditedFilesTitle } from './agent-chat-diff-labels';
import { AgentChatDiff } from './agent-chat-file-changes';
import { AgentChatTurnUndoButton } from './agent-chat-turn-undo-button';
import { useAgentChatTurnReviewOpener } from './hooks/use-agent-chat-task-link';

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
 * row, with its counts at the end. Clicking it discloses the file's diff. A file the turn did not delete also offers
 * Open in Editor at the row's end, revealed while the pointer is over the row or keyboard focus is in it.
 */
function EditedFileRow({
    displayPath,
    file,
    isExpanded,
    onOpen,
    onToggle,
}: {
    displayPath: string;
    file: AgentChatEditedFile;
    isExpanded: boolean;
    /**
     * Opens the file in the editor, or `undefined` when the file is gone or the card has no Session to open it in.
     */
    onOpen?: () => void;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    const detailId = useId();
    const directory = parentDirectoryPath(displayPath);
    return (
        <li className="group/file-row border-t border-border">
            <div className="flex min-w-0 items-center hover:bg-elevated">
                <button
                    aria-controls={detailId}
                    aria-expanded={isExpanded}
                    aria-label={t(
                        isExpanded
                            ? 'agentChat.changes.hideFileChanges'
                            : 'agentChat.changes.showFileChanges',
                        { path: displayPath, stat: diffStatLabel(file, t) },
                    )}
                    className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent px-3 text-left text-[12px] focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-accent"
                    type="button"
                    onClick={onToggle}
                >
                    <span className="min-w-0 flex-1 truncate">
                        {directory && <span className="text-muted">{directory}/</span>}
                        <span className="text-foreground">{pathBasename(displayPath)}</span>
                    </span>
                    <DiffStat additions={file.additions} deletions={file.deletions} />
                </button>
                {onOpen && (
                    <Tooltip content={t('agentChat.changes.openInEditor')}>
                        <Button
                            aria-label={t('agentChat.changes.openPathInEditor', {
                                path: displayPath,
                            })}
                            className="mr-2 -ml-1 size-6 shrink-0 rounded-md text-muted opacity-0 transition-opacity group-focus-within/file-row:opacity-100 group-hover/file-row:opacity-100 enabled:hover:text-foreground"
                            size="icon"
                            variant="ghost"
                            onClick={onOpen}
                        >
                            <FileSymlink aria-hidden="true" className="size-3.5" />
                        </Button>
                    </Tooltip>
                )}
            </div>
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
    const openTurnReview = useAgentChatTurnReviewOpener();
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const detailId = useId();
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
                {sessionId !== undefined && (
                    <AgentChatTurnUndoButton
                        displayPath={displayPath}
                        files={files}
                        isPartial={isPartial}
                        sessionId={sessionId}
                        turnId={turnId}
                    />
                )}
                {openTurnReview && (
                    <Tooltip content={t('agentChat.review.tooltip')}>
                        <Button
                            className="shrink-0 gap-1 text-[12px]"
                            size="sm"
                            variant="secondary"
                            onClick={() => openTurnReview(turnId)}
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
                            onOpen={
                                sessionId !== undefined && file.kind !== 'delete'
                                    ? () => {
                                          // eslint-disable-next-line no-void -- openFileForSession reports failures through tryCommand
                                          void openFileForSession(sessionId, file.path);
                                      }
                                    : undefined
                            }
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
