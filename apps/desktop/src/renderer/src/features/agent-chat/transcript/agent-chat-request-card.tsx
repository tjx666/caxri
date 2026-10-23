import { useEffect, useRef, useState } from 'react';

import type { AgentChatItem, AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import {
    AGENT_CHAT_EXIT_PLAN_TOOL,
    agentChatApprovalChoices,
    agentChatRequestTitle,
} from '@caxri/protocol';

import { useColorizedCode } from '../../../components/markdown/use-colorized-code';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { answerAgentChatRequest } from '../agent-chat-commands';
import { AgentChatMessage } from '../messages/agent-chat-message';
import {
    AGENT_CHAT_APPROVE_SHORTCUT,
    AGENT_CHAT_DENY_SHORTCUT,
} from '../permissions/agent-chat-approval-keys';
import {
    AGENT_CHAT_APPROVAL_ATTRIBUTE,
    useAgentChatApprovalKeys,
} from '../permissions/use-agent-chat-approval-keys';
import { AgentChatFileChanges } from '../turns/agent-chat-file-changes';
import { agentChatCommandCwd, isApprovalClickGuarded } from './agent-chat-presentation';
import { AgentChatQuestionForm } from './questions/agent-chat-question-form';

/**
 * The files an approval would change, read from the timeline item it gates: the provider announces the file change
 * before asking, so the card can show the diff "Accept" applies instead of asking blind. A single file opens straight
 * to its diff; several start as headers so the decision buttons stay close.
 */
function ApprovalFiles({ item }: { item: AgentChatItem | undefined }) {
    if (item?.type !== 'fileChange' || item.changes.length === 0) return null;
    return <AgentChatFileChanges changes={item.changes} expandAtMost={1} status={item.status} />;
}

const APPROVAL_PRE_CLASS_NAME =
    'm-0 max-h-40 overflow-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-4 wrap-anywhere whitespace-pre-wrap text-foreground';

/**
 * What a tool approval would act on. The plan Claude Code proposes when leaving plan mode is Markdown written for a
 * reader, so it renders as a reply does, with room to read it; any other tool's arguments stay a bounded code preview.
 */
function ApprovalToolSummary({ name, summary }: { name: string; summary: string }) {
    if (name === AGENT_CHAT_EXIT_PLAN_TOOL)
        return (
            <div className="max-h-96 overflow-y-auto rounded bg-background px-3 py-2">
                <AgentChatMessage className="text-foreground" isStreaming={false} text={summary} />
            </div>
        );
    return <pre className={APPROVAL_PRE_CLASS_NAME}>{summary}</pre>;
}

/**
 * An approval's body: what it would act on and the decision buttons.
 */
function ApprovalBody({
    armDelayMs,
    choices,
    isAnswering,
    linkedItem,
    projectRoot,
    request,
    respond,
    reviewHint,
    title,
}: {
    /**
     * Pointer clicks are ignored for this long after the card appears (see `isApprovalClickGuarded`).
     */
    armDelayMs: number;
    choices: ReturnType<typeof agentChatApprovalChoices>;
    isAnswering: boolean;
    linkedItem: AgentChatItem | undefined;
    projectRoot: string | undefined;
    request: Exclude<AgentChatRequest, { kind: 'question' }>;
    respond: (response: AgentChatResponse) => void;
    reviewHint: string | undefined;
    title: string;
}) {
    const { t } = useTranslation();
    // The card is keyed by request, so mount time is when this request appeared.
    const [shownAt] = useState(() => performance.now());
    const [isArmed, setArmed] = useState(armDelayMs <= 0);
    useEffect(() => {
        if (armDelayMs <= 0) return;
        const timer = setTimeout(() => setArmed(true), armDelayMs);
        return () => clearTimeout(timer);
    }, [armDelayMs]);
    const cwd =
        request.kind === 'command' ? agentChatCommandCwd(request.cwd, projectRoot) : undefined;
    const command = request.kind === 'command' ? request.command : undefined;
    // Painted with the editor's colors like the command on a work row, so the approval reads the same as the run.
    const { html: commandHtml } = useColorizedCode(command ?? '', 'shell', Boolean(command));
    return (
        <>
            <h3 className="m-0 text-[12px] font-semibold text-foreground">{title}</h3>
            {request.kind === 'tool' && request.summary && (
                <ApprovalToolSummary name={request.name} summary={request.summary} />
            )}
            {command && (
                <pre className={APPROVAL_PRE_CLASS_NAME}>
                    {commandHtml ? (
                        /**
                         * Monaco's colorizer escapes the source and wraps it only in its own color-class spans;
                         * `colorizeCode` rejects any other markup shape before it reaches here.
                         */
                        <code dangerouslySetInnerHTML={{ __html: commandHtml }} />
                    ) : (
                        <code>{command}</code>
                    )}
                </pre>
            )}
            {cwd && (
                <p className="m-0 font-mono text-[11px] wrap-anywhere text-muted">
                    {t('agentChat.request.cwd', { cwd })}
                </p>
            )}
            {request.kind === 'fileChange' && <ApprovalFiles item={linkedItem} />}
            {request.reason && <p className="m-0 text-muted">{request.reason}</p>}
            {reviewHint && <p className="m-0 text-muted">{reviewHint}</p>}
            <div className="flex flex-wrap gap-2">
                {choices.map(({ decision, label }) => {
                    const button = (
                        <Button
                            aria-keyshortcuts={
                                decision === 'accept'
                                    ? 'Meta+Enter'
                                    : decision === 'decline'
                                      ? 'Meta+Backspace'
                                      : undefined
                            }
                            aria-disabled={!isArmed || undefined}
                            disabled={isAnswering}
                            key={decision}
                            size="sm"
                            variant={
                                decision === 'accept'
                                    ? 'default'
                                    : decision === 'decline'
                                      ? 'ghost'
                                      : 'secondary'
                            }
                            onClick={(event) => {
                                // `aria-disabled` keeps focus where it is; the click is refused here instead.
                                if (
                                    isApprovalClickGuarded({
                                        armDelayMs,
                                        detail: event.detail,
                                        elapsedMs: performance.now() - shownAt,
                                    })
                                )
                                    return;
                                respond({ kind: 'decision', decision });
                            }}
                        >
                            {label}
                        </Button>
                    );
                    if (decision === 'acceptForSession') return button;
                    return (
                        <Tooltip
                            content={label}
                            key={decision}
                            shortcut={
                                decision === 'accept'
                                    ? AGENT_CHAT_APPROVE_SHORTCUT
                                    : AGENT_CHAT_DENY_SHORTCUT
                            }
                        >
                            {button}
                        </Tooltip>
                    );
                })}
            </div>
        </>
    );
}

/**
 * A pending approval or question. It sits above the composer rather than in the timeline so the turn that waits on it
 * can never scroll it out of view. Answering takes it away at once (`answerAgentChatRequest`), and a failed answer
 * brings it back; its controls go inert on the first answer, so a double click cannot answer twice. The first approval
 * in the pane also answers to the keyboard (Cmd+Enter accepts, Cmd+Backspace denies) while the composer is empty, and
 * its buttons' tooltips say so.
 */
export function AgentChatRequestCard({
    approvalArmDelayMs = 0,
    isFramed = true,
    isWindowWide = false,
    linkedItem,
    onAnswered,
    onEscape,
    projectRoot,
    providerName,
    request,
    reviewHint,
    terminalId,
}: {
    /**
     * Ignores pointer clicks on the approval buttons for this long after the card appears, and makes a question
     * option's click only select it in that time; for a card that drops in on its own (the waiting popup), where the
     * second click of a double click aimed at the previous card, or a click meant for what was under the pointer, must
     * not decide this one.
     */
    approvalArmDelayMs?: number;
    /**
     * Replaces Escape's Skip on a question with this action (the waiting popup folds instead of skipping).
     */
    onEscape?: () => void;
    /**
     * Muted line above an approval's buttons.
     */
    reviewHint?: string;
    /**
     * Draws the card's own warning frame; off where a surrounding surface (the waiting popup) already frames it, so the
     * request does not read as a card nested in a card.
     */
    isFramed?: boolean;
    /**
     * Lets a question take Enter from anywhere in the window, for a card outside any Chat (the waiting popup); see
     * `useAgentChatQuestionEnterKey`.
     */
    isWindowWide?: boolean;
    /**
     * Timeline item the request gates, when the provider linked one.
     */
    linkedItem: AgentChatItem | undefined;
    /**
     * Runs as an answer takes this card away, so a keyboard user who answered from the card is not dropped onto the
     * document body when its focused button unmounts.
     */
    onAnswered: () => void;
    projectRoot: string | undefined;
    /**
     * The provider catalog's display name, which a question names as the one asking.
     */
    providerName: string;
    request: AgentChatRequest;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const [isAnswering, setAnswering] = useState(false);
    const cardReference = useRef<HTMLElement>(null);
    const respond = (response: AgentChatResponse): void => {
        if (isAnswering) return;
        setAnswering(true);
        void answerAgentChatRequest(terminalId, request, response);
        // The card leaves with this click; focus inside it moves on rather than dropping to the document body.
        const focused = document.activeElement;
        if (focused === document.body || cardReference.current?.contains(focused)) onAnswered();
    };
    const choices = request.kind === 'question' ? [] : agentChatApprovalChoices(request, t);
    useAgentChatApprovalKeys(cardReference, {
        isEnabled: choices.length > 0 && !isAnswering,
        onDecision: (decision) => {
            if (choices.some((choice) => choice.decision === decision))
                respond({ kind: 'decision', decision });
        },
    });
    const title = agentChatRequestTitle(request, providerName, t);
    return (
        <section
            ref={cardReference}
            aria-busy={isAnswering}
            aria-label={title}
            className={cn(
                'space-y-2 text-[12px] leading-5',
                isFramed && 'rounded-lg border border-warning bg-surface px-3 py-2.5',
            )}
            {...(request.kind !== 'question' && { [AGENT_CHAT_APPROVAL_ATTRIBUTE]: '' })}
        >
            {request.kind === 'question' ? (
                <AgentChatQuestionForm
                    isAnswering={isAnswering}
                    isWindowWide={isWindowWide}
                    armDelayMs={approvalArmDelayMs}
                    onEscape={onEscape}
                    providerName={providerName}
                    request={request}
                    respond={respond}
                    terminalId={terminalId}
                    title={title}
                />
            ) : (
                <ApprovalBody
                    armDelayMs={approvalArmDelayMs}
                    choices={choices}
                    isAnswering={isAnswering}
                    linkedItem={linkedItem}
                    projectRoot={projectRoot}
                    request={request}
                    respond={respond}
                    reviewHint={reviewHint}
                    title={title}
                />
            )}
        </section>
    );
}
