import { useId, useState } from 'react';

import type { AgentChatHandoff, AgentChatUsageGuard } from '@caxri/protocol';
import { agentChatUsageGuardOffer, agentProviderCatalog } from '@caxri/protocol';
import { ChevronRight, FileText, Gauge } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { writeToClipboardWithFeedback } from '../../../components/copy-feedback';
import { DisclosureMotion } from '../../../components/disclosure-motion';
import { CopyIconButton } from '../../../components/markdown/copy-icon-button';
import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { textClipboard } from '../../../lib/clipboard';
import { localizedLimitReset } from '../../../lib/usage-format';
import { cn } from '../../../lib/utilities';
import {
    toggleAgentChatStripFold,
    useIsAgentChatStripSectionCollapsed,
} from '../composer/strip/agent-chat-strip-folds';
import { agentChatChevronMotion } from '../transcript/agent-chat-disclosure';
import { AgentChatAutoContinueActions } from './agent-chat-auto-continue-actions';
import { AgentChatAutoContinueLine } from './agent-chat-auto-continue-line';
import { AgentChatContinueInAgent } from './agent-chat-continue-in-agent';
import {
    bypassAgentChatUsageGuard,
    generateAgentChatHandoff,
} from './agent-chat-usage-limit-commands';

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
                    copy={() => writeToClipboardWithFeedback(textClipboard, document.text)}
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
 * the week is used and when it resets, why new requests are refused, and the ways forward. "Generate hand-off" spends
 * the kept budget once per account on a document this Chat's own model writes; "Open in another Agent" continues from a
 * package Server Core builds without asking the provider anything; "Continue anyway" lifts the guard for the rest of
 * the window, for a user who knows better (another account signed in, the last percent is enough). The headline folds
 * the explanation and hand-off document away, remembered per Chat like the strip sections, so a long document does not
 * keep the transcript short. The action buttons stay below the fold: while the guard blocks sending they are the only
 * way forward, so folding never hides them. The row replaces the context alerts, whose Compact and new-Chat actions the
 * guard refuses too.
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
    const [isBypassing, setBypassing] = useState(false);
    const isCollapsed = useIsAgentChatStripSectionCollapsed(terminalId, 'usageGuard');
    const [hasToggled, setToggled] = useState(false);
    const bodyId = useId();
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
    const continueAnyway = (): void => {
        if (isBypassing) return;
        setBypassing(true);
        void bypassAgentChatUsageGuard(terminalId).finally(() => setBypassing(false));
    };
    const toggle = (): void => {
        setToggled(true);
        toggleAgentChatStripFold(terminalId, 'usageGuard');
    };
    return (
        <div
            className="flex min-w-0 flex-col border-0 border-b border-solid border-border px-3 py-2 text-[12px] leading-5"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-usage-guard={guard.handoff}
        >
            <button
                aria-controls={bodyId}
                aria-expanded={!isCollapsed}
                className="flex min-w-0 cursor-pointer items-start gap-2 rounded border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-accent"
                data-agent-chat-usage-guard-fold=""
                type="button"
                onClick={toggle}
            >
                <Gauge aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span className="min-w-0 flex-1 text-warning">
                    {t('agentChat.usageGuard.headline', {
                        provider: providerName,
                        percent: Math.floor(guard.usedPercent),
                    })}
                </span>
                <ChevronRight
                    aria-hidden
                    className={cn(
                        'mt-0.5 size-3.5 shrink-0 text-muted',
                        agentChatChevronMotion(!isCollapsed),
                        !isCollapsed && 'rotate-90',
                    )}
                />
            </button>
            <DisclosureMotion
                animate={hasToggled}
                expanded={!isCollapsed}
                id={bodyId}
                kind="agent-chat-usage-guard"
            >
                <div className="flex min-w-0 flex-col gap-2 pt-0.5 pl-5.5">
                    <div>
                        <div className="text-muted">
                            {t('agentChat.usageGuard.detail', {
                                reset: localizedLimitReset(guard.resetsAt, now, t),
                            })}
                            {offer.used && ` ${t('agentChat.usageGuard.used')}`}
                        </div>
                        {guard.autoContinue && (
                            <AgentChatAutoContinueLine autoContinue={guard.autoContinue} />
                        )}
                    </div>
                    {guard.document && <HandoffDocument document={guard.document} />}
                </div>
            </DisclosureMotion>
            <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1.5 pl-5.5">
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
                <AgentChatAutoContinueActions
                    autoContinue={guard.autoContinue}
                    canContinueNow={false}
                    terminalId={terminalId}
                    turnId={guard.autoContinueTurnId ?? ''}
                />
                <AgentChatContinueInAgent
                    continuedIn={guard.continuedIn}
                    label="openElsewhere"
                    terminalId={terminalId}
                    turnId={undefined}
                />
                <Tooltip
                    content={t('agentChat.usageGuard.continueAnywayTooltip', {
                        provider: providerName,
                    })}
                >
                    <Button
                        aria-disabled={isBypassing || undefined}
                        className="min-h-6 gap-1.5 px-2 text-[12px]"
                        data-agent-chat-usage-guard-bypass=""
                        size="sm"
                        variant="ghost"
                        onClick={continueAnyway}
                    >
                        {isBypassing && <Spinner className="size-3.5" role="presentation" />}
                        {t('agentChat.usageGuard.continueAnyway')}
                    </Button>
                </Tooltip>
            </div>
        </div>
    );
}
