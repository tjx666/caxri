import { useState } from 'react';

import type { AgentChatDecision, AgentChatItem, AgentChatRequest } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { didAnswerAgentChatRequest } from './agent-chat-commands';
import { AgentChatFileChanges } from './agent-chat-file-changes';
import {
    agentChatApprovalChoices,
    agentChatCommandCwd,
    agentChatQuestionAnswers,
    agentChatRequestTitle,
} from './agent-chat-presentation';

type AgentChatResponse =
    | { kind: 'decision'; decision: AgentChatDecision }
    | { kind: 'answers'; answers: Record<string, string[]> };

function QuestionForm({
    isAnswering,
    request,
    respond,
}: {
    isAnswering: boolean;
    request: Extract<AgentChatRequest, { kind: 'question' }>;
    respond: (response: AgentChatResponse) => void;
}) {
    const [selected, setSelected] = useState<Record<string, string | undefined>>({});
    const [other, setOther] = useState<Record<string, string | undefined>>({});
    const answers = agentChatQuestionAnswers(selected, other);
    const isComplete = request.questions.every((question) => Object.hasOwn(answers, question.id));
    return (
        <form
            className="space-y-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (isComplete && !isAnswering) respond({ kind: 'answers', answers });
            }}
        >
            {request.questions.map((question) => (
                <fieldset className="m-0 space-y-1.5 border-0 p-0" key={question.id}>
                    <legend className="mb-1 p-0 text-[12px] text-foreground">
                        {question.header && (
                            <span className="mr-1 font-semibold">{question.header}</span>
                        )}
                        {question.question}
                    </legend>
                    <div className="flex flex-wrap gap-1.5">
                        {question.options.map((option) => {
                            const isSelected =
                                selected[question.id] === option.label && !other[question.id];
                            return (
                                <Tooltip
                                    content={option.description}
                                    disabled={!option.description}
                                    key={option.label}
                                >
                                    <Button
                                        aria-pressed={isSelected}
                                        className={cn(
                                            isSelected && 'bg-[var(--selection)] text-foreground',
                                        )}
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => {
                                            setSelected((value) => ({
                                                ...value,
                                                [question.id]: option.label,
                                            }));
                                            setOther((value) => ({ ...value, [question.id]: '' }));
                                        }}
                                    >
                                        {option.label}
                                    </Button>
                                </Tooltip>
                            );
                        })}
                    </div>
                    {(question.allowsOther || question.options.length === 0) && (
                        <Input
                            aria-label={`Other answer: ${question.question}`}
                            placeholder="Other answer"
                            value={other[question.id] ?? ''}
                            onChange={(event) =>
                                setOther((value) => ({
                                    ...value,
                                    [question.id]: event.target.value,
                                }))
                            }
                        />
                    )}
                </fieldset>
            ))}
            <div className="flex gap-2">
                <Button disabled={!isComplete || isAnswering} size="sm" type="submit">
                    Submit
                </Button>
                <Button
                    disabled={isAnswering}
                    size="sm"
                    variant="ghost"
                    onClick={() => respond({ kind: 'decision', decision: 'cancel' })}
                >
                    Skip
                </Button>
            </div>
        </form>
    );
}

/**
 * The files an approval would change, read from the timeline item it gates: the provider announces the file change
 * before asking, so the card can show the diff "Accept" applies instead of asking blind. A single file opens straight to
 * its diff; several start as headers so the decision buttons stay close.
 */
function ApprovalFiles({ item }: { item: AgentChatItem | undefined }) {
    if (item?.type !== 'fileChange' || item.changes.length === 0) return null;
    return <AgentChatFileChanges changes={item.changes} expandAtMost={1} status={item.status} />;
}

/**
 * A pending approval or question. It sits above the composer rather than in the timeline so the turn that waits on it
 * can never scroll it out of view. Its controls stay disabled while an answer is in flight, so a double click cannot
 * answer twice, and come back only when the answer failed.
 */
export function AgentChatRequestCard({
    linkedItem,
    projectRoot,
    request,
    terminalId,
}: {
    /**
     * Timeline item the request gates, when the provider linked one.
     */
    linkedItem: AgentChatItem | undefined;
    projectRoot: string | undefined;
    request: AgentChatRequest;
    terminalId: string;
}) {
    const [isAnswering, setAnswering] = useState(false);
    const respond = (response: AgentChatResponse): void => {
        if (isAnswering) return;
        setAnswering(true);
        // eslint-disable-next-line no-void -- the command reports its own failure through tryCommand
        void didAnswerAgentChatRequest(terminalId, request.id, response).then((isAnswered) => {
            if (!isAnswered) setAnswering(false);
        });
    };
    const cwd =
        request.kind === 'command' ? agentChatCommandCwd(request.cwd, projectRoot) : undefined;
    return (
        <section
            aria-busy={isAnswering}
            aria-label={agentChatRequestTitle(request)}
            className="space-y-2 rounded-lg border border-warning bg-surface px-3 py-2.5 text-[12px] leading-5"
        >
            <h3 className="m-0 text-[12px] font-semibold text-foreground">
                {agentChatRequestTitle(request)}
            </h3>
            {request.kind === 'question' ? (
                <QuestionForm isAnswering={isAnswering} request={request} respond={respond} />
            ) : (
                <>
                    {request.kind === 'tool' && request.summary && (
                        <pre className="m-0 max-h-40 overflow-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-4 wrap-anywhere whitespace-pre-wrap text-foreground">
                            {request.summary}
                        </pre>
                    )}
                    {request.kind === 'command' && request.command && (
                        <pre className="m-0 max-h-40 overflow-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-4 wrap-anywhere whitespace-pre-wrap text-foreground">
                            {request.command}
                        </pre>
                    )}
                    {cwd && (
                        <p className="m-0 font-mono text-[11px] wrap-anywhere text-muted">
                            in {cwd}
                        </p>
                    )}
                    {request.kind === 'fileChange' && <ApprovalFiles item={linkedItem} />}
                    {request.reason && <p className="m-0 text-muted">{request.reason}</p>}
                    <div className="flex flex-wrap gap-2">
                        {agentChatApprovalChoices(request).map(({ decision, label }) => (
                            <Button
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
                                onClick={() => respond({ kind: 'decision', decision })}
                            >
                                {label}
                            </Button>
                        ))}
                    </div>
                </>
            )}
        </section>
    );
}
