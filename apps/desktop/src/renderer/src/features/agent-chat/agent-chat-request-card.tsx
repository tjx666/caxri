import { useState } from 'react';

import type { AgentChatRequest } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { answerAgentChatQuestions, decideAgentChatRequest } from './agent-chat-commands';
import { agentChatQuestionAnswers, agentChatRequestTitle } from './agent-chat-presentation';

function QuestionForm({
    request,
    terminalId,
}: {
    request: Extract<AgentChatRequest, { kind: 'question' }>;
    terminalId: string;
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
                if (isComplete) answerAgentChatQuestions(terminalId, request.id, answers);
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
                <Button disabled={!isComplete} size="sm" type="submit">
                    Submit
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => decideAgentChatRequest(terminalId, request.id, 'cancel')}
                >
                    Skip
                </Button>
            </div>
        </form>
    );
}

/**
 * A pending approval or question. It sits above the composer rather than in the timeline so the turn that waits on it
 * can never scroll it out of view.
 */
export function AgentChatRequestCard({
    request,
    terminalId,
}: {
    request: AgentChatRequest;
    terminalId: string;
}) {
    const decide = (decision: 'accept' | 'acceptForSession' | 'decline'): void =>
        decideAgentChatRequest(terminalId, request.id, decision);
    return (
        <section
            aria-label={agentChatRequestTitle(request)}
            className="space-y-2 rounded-lg border border-warning bg-surface px-3 py-2.5 text-[12px] leading-5"
        >
            <h3 className="m-0 text-[12px] font-semibold text-foreground">
                {agentChatRequestTitle(request)}
            </h3>
            {request.kind === 'question' ? (
                <QuestionForm request={request} terminalId={terminalId} />
            ) : (
                <>
                    {request.kind === 'command' && request.command && (
                        <pre className="m-0 max-h-40 overflow-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-4 wrap-anywhere whitespace-pre-wrap text-foreground">
                            {request.command}
                        </pre>
                    )}
                    {request.kind === 'command' && request.cwd && (
                        <p className="m-0 wrap-anywhere text-muted">in {request.cwd}</p>
                    )}
                    {request.reason && <p className="m-0 text-muted">{request.reason}</p>}
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => decide('accept')}>
                            Accept
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => decide('acceptForSession')}
                        >
                            Accept for Session
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => decide('decline')}>
                            Decline
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}
