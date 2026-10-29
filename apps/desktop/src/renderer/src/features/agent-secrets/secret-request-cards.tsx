import { useState } from 'react';

import type { AgentSecretRequest } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { KeyRound, SquareArrowOutUpRight } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { useCaxriQuery } from '../../queries/client';
import { useProjectById, useSessionById, useTerminal } from '../../stores/selectors';
import { openAgentChatWaiting } from '../agent-chat/waiting/agent-chat-waiting-commands';
import { sessionTitleForDisplay } from '../session/session-title';
import { answerAgentSecretRequest } from './agent-secrets-client';
import { secretAnswerFailure, secretRequestAnswer } from './agent-secrets-summary';

/**
 * Asks the user for a secret an Agent requested with `caxri secret request`, from anywhere in the window and for Chat
 * and PTY Agents alike. It sits in the bottom-right corner above the status bar and never takes focus by itself, so a
 * request arriving mid-typing cannot capture keystrokes meant for an editor or Terminal. One request shows at a time,
 * oldest first; the rest wait behind it. A request leaves when it is answered, when the Agent stops waiting, or when it
 * expires, all through `agentSecrets.changed`. The card follows T3 Code's secret request (see
 * `.agents/skills/competitors/references/feature-references.md`).
 */
export function SecretRequestCards() {
    const query = useCaxriQuery('secrets.requests.list', {});
    const requests = query.data?.requests ?? [];
    const current = requests.toSorted((left, right) => left.createdAt - right.createdAt).at(0);
    if (!current) return null;
    return (
        <div className="pointer-events-none fixed right-4 bottom-10 z-40 flex w-[min(400px,92vw)] flex-col items-stretch">
            <SecretRequestCard key={current.id} moreCount={requests.length - 1} request={current} />
        </div>
    );
}

function SecretRequestCard({
    moreCount,
    request,
}: {
    moreCount: number;
    request: AgentSecretRequest;
}) {
    const { t } = useTranslation();
    const session = useSessionById(request.sessionId);
    const project = useProjectById(request.projectId);
    const terminal = useTerminal(request.terminalId);
    const provider = terminal?.provider ? agentProviderCatalog[terminal.provider] : undefined;
    /**
     * The value lives only in this component's state: it is sent once and dropped with the card, and nothing here logs,
     * persists, or echoes it.
     */
    const [value, setValue] = useState('');
    const [isGlobal, setIsGlobal] = useState(false);
    const [isAnswering, setIsAnswering] = useState(false);
    const [failure, setFailure] = useState<'failed' | 'gone' | undefined>();

    const answer = async (action: 'save' | 'decline') => {
        if (isAnswering || (action === 'save' && value.length === 0)) return;
        setIsAnswering(true);
        setFailure(undefined);
        const parameters = {
            requestId: request.id,
            answer: secretRequestAnswer(action, value, isGlobal),
        };
        try {
            await answerAgentSecretRequest(parameters);
            setValue('');
        } catch (error) {
            setFailure(secretAnswerFailure(error));
            setIsAnswering(false);
        }
    };

    return (
        <section
            aria-label={t('agentSecrets.request.title', {
                agent: provider?.displayName ?? t('agentSecrets.request.agentFallback'),
            })}
            className="pointer-events-auto grid gap-3 rounded-lg border border-border bg-elevated p-3 text-foreground shadow-[0_12px_32px_var(--shadow)]"
            data-agent-secret-request={request.id}
        >
            <header className="flex items-start gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                    <KeyRound aria-hidden="true" className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1 leading-4">
                    <p className="m-0 text-[13px] font-semibold">
                        {t('agentSecrets.request.title', {
                            agent: provider?.displayName ?? t('agentSecrets.request.agentFallback'),
                        })}
                    </p>
                    <p className="m-0 mt-0.5 flex min-w-0 gap-1.5 text-[12px] text-muted">
                        <span className="truncate">
                            {session ? sessionTitleForDisplay(session.title, t) : ''}
                        </span>
                        {project && <span className="shrink-0 truncate">{project.title}</span>}
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        void openAgentChatWaiting(request.sessionId, request.terminalId);
                    }}
                >
                    <SquareArrowOutUpRight className="size-3.5" />
                    {t('agentSecrets.request.openSession')}
                </Button>
            </header>
            <div className="grid gap-1">
                <span className="text-[11px] text-muted">
                    {t('agentSecrets.request.reasonLabel')}
                </span>
                <p className="m-0 max-h-24 overflow-auto text-[12px] break-words whitespace-pre-wrap">
                    {request.reason}
                </p>
            </div>
            <form
                className="grid gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void answer('save');
                }}
            >
                <label className="grid gap-1">
                    <span className="font-mono text-[12px]">{request.name}</span>
                    {/* `data-1p-ignore` and `data-lpignore` keep password managers from offering to fill or save it. */}
                    <Input
                        aria-label={t('agentSecrets.request.valueLabel', { name: request.name })}
                        autoComplete="off"
                        className="bg-background font-mono"
                        data-1p-ignore
                        data-lpignore="true"
                        disabled={isAnswering}
                        spellCheck={false}
                        type="password"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                    />
                </label>
                <label className="flex items-center gap-2 text-[12px]">
                    <Checkbox
                        checked={isGlobal}
                        disabled={isAnswering}
                        onCheckedChange={(checked) => setIsGlobal(checked)}
                    />
                    {t('agentSecrets.request.allProjects')}
                </label>
                <p className="m-0 text-[11px] text-muted">{t('agentSecrets.request.privacy')}</p>
                {failure && (
                    <p className="m-0 text-[11px] text-danger" role="alert">
                        {t(
                            failure === 'gone'
                                ? 'agentSecrets.request.gone'
                                : 'agentSecrets.request.failed',
                        )}
                    </p>
                )}
                <div className="flex items-center justify-end gap-2">
                    {moreCount > 0 && (
                        <span className="mr-auto text-[11px] text-muted">
                            {t('agentSecrets.request.more', { count: moreCount })}
                        </span>
                    )}
                    <Button
                        disabled={isAnswering}
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() => {
                            void answer('decline');
                        }}
                    >
                        {t('agentSecrets.request.decline')}
                    </Button>
                    <Button disabled={isAnswering || value.length === 0} size="sm" type="submit">
                        {isAnswering && <Spinner />}
                        {t('agentSecrets.request.save')}
                    </Button>
                </div>
            </form>
        </section>
    );
}
