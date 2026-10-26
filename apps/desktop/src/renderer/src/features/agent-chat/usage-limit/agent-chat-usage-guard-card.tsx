import { useState } from 'react';

import type { AgentChatHandoff, AgentChatUsageGuard } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { FileText, Gauge } from 'lucide-react';

import { writeToClipboardWithFeedback } from '../../../components/copy-feedback';
import { CopyIconButton } from '../../../components/markdown/copy-icon-button';
import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { localizedLimitReset } from '../../../lib/usage-format';
import { useClockTick } from '../hooks/use-clock-tick';
import { agentChatUsageGuardOffer } from './agent-chat-continuation';
import { AgentChatContinueInAgent } from './agent-chat-continue-in-agent';
import { generateAgentChatHandoff } from './agent-chat-usage-limit-commands';

/**
 * The hand-off document this Chat's model wrote, or where it stands: a spinner while it writes, the reason it failed
 * (the deterministic "Open in another Agent" still works), or the text itself, scrollable and copyable.
 */
function HandoffDocument({ document }: { document: AgentChatHandoff }) {
    const { t } = useTranslation();
    if (document.status === 'generating')
        return (
            <div className="flex items-center gap-2 text-muted">
                <Spinner className="size-3.5" role="presentation" />
                {t('agentChat.usageGuard.generating')}
            </div>
        );
    if (document.status === 'failed')
        return (
            <div className="text-muted" data-agent-chat-handoff-failed={document.reason}>
                {t(`agentChat.usageGuard.failed.${document.reason}`)}
            </div>
        );
    return (
        <div
            className="rounded-md border border-solid border-border bg-elevated"
            data-agent-chat-handoff-document=""
        >
            <div className="flex h-7 items-center gap-1.5 border-0 border-b border-solid border-border pr-1 pl-2 text-muted">
                <FileText aria-hidden className="size-3.5 shrink-0" />
                <span className="flex-1 truncate">{t('agentChat.usageGuard.document')}</span>
                <CopyIconButton
                    copy={() => writeToClipboardWithFeedback(navigator.clipboard, document.text)}
                    label={t('agentChat.usageGuard.copy')}
                />
            </div>
            <div className="max-h-40 overflow-auto px-2 py-1.5 wrap-anywhere whitespace-pre-wrap text-foreground select-text">
                {document.text}
            </div>
        </div>
    );
}

/**
 * The composer's first row while this Chat's provider account is at the weekly usage guard (issue #2580): how much of
 * the week is used and when it resets, why new requests are refused, and the only two ways forward. "Generate hand-off"
 * spends the kept budget once per account on a document this Chat's own model writes; "Open in another Agent" continues
 * from a package Server Core builds without asking the provider anything. There is deliberately no "Continue anyway".
 * The row replaces the context alerts, whose Compact and new-Chat actions the guard refuses too.
 */
export function AgentChatUsageGuardCard({
    guard,
    terminalId,
}: {
    guard: AgentChatUsageGuard;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    const [isClaiming, setClaiming] = useState(false);
    const providerName = resolveAgentIcon(guard.provider).label;
    const offer = agentChatUsageGuardOffer(
        guard,
        agentProviderCatalog[guard.provider].capabilities.chatSideQuestion,
    );
    const generate = (): void => {
        if (isClaiming) return;
        setClaiming(true);
        void generateAgentChatHandoff(terminalId).finally(() => setClaiming(false));
    };
    return (
        <div
            className="flex min-w-0 flex-col gap-2 border-0 border-b border-solid border-border px-3 py-2 text-[12px] leading-5"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-usage-guard={guard.handoff}
        >
            <div className="flex min-w-0 items-start gap-2">
                <Gauge aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                    <div className="text-warning">
                        {t('agentChat.usageGuard.headline', {
                            provider: providerName,
                            percent: Math.floor(guard.usedPercent),
                        })}
                    </div>
                    <div className="text-muted">
                        {t('agentChat.usageGuard.detail', {
                            reset: localizedLimitReset(guard.resetsAt, now, t),
                        })}
                        {offer.used && ` ${t('agentChat.usageGuard.used')}`}
                    </div>
                </div>
            </div>
            {guard.document && <HandoffDocument document={guard.document} />}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {offer.generate && (
                    <Tooltip
                        content={t('agentChat.usageGuard.generateTooltip', {
                            provider: providerName,
                        })}
                    >
                        <Button
                            aria-disabled={isClaiming || undefined}
                            className="min-h-6 gap-1.5 px-2 text-[12px]"
                            data-agent-chat-generate-handoff=""
                            size="sm"
                            variant="secondary"
                            onClick={generate}
                        >
                            {isClaiming && <Spinner className="size-3.5" role="presentation" />}
                            {t('agentChat.usageGuard.generate')}
                        </Button>
                    </Tooltip>
                )}
                <AgentChatContinueInAgent
                    continuedIn={guard.continuedIn}
                    label="openElsewhere"
                    terminalId={terminalId}
                    turnId={undefined}
                />
            </div>
        </div>
    );
}
