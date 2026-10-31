import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { useAgentChatVersions } from './use-agent-chat-versions';

const STEP_BUTTON_CLASS =
    'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted';

/**
 * `‹ 1/2 ›` under a user message "Edit from here" replaced: stepping it swaps the message and everything after it for
 * another version, read-only, while the conversation continues on the last one, which says "Current". The position is a
 * polite status so a screen reader announces "Version 1 of 2" after each step. Renders nothing for a message with no
 * earlier versions.
 */
export function AgentChatVersionSwitcher({ id }: { id: string }) {
    const { t } = useTranslation();
    const versions = useAgentChatVersions();
    const switcher = versions?.switcher(id);
    if (!versions || !switcher) return null;
    const { index, count } = switcher;
    const isCurrent = index === count - 1;
    const position = t('agentChat.version.position', { index: index + 1, count });
    return (
        <div
            className="flex items-center text-[12px] text-muted"
            data-agent-chat-version-switcher=""
        >
            <Tooltip content={t('agentChat.version.previous')}>
                <button
                    aria-label={t('agentChat.version.previous')}
                    className={STEP_BUTTON_CLASS}
                    disabled={index === 0}
                    type="button"
                    onClick={() => versions.step(switcher, index - 1)}
                >
                    <ChevronLeft aria-hidden="true" className="size-3.5" />
                </button>
            </Tooltip>
            <span aria-label={position} aria-live="polite" className="tabular-nums" role="status">
                {index + 1}/{count}
                {isCurrent && <span className="ml-1">· {t('agentChat.version.current')}</span>}
            </span>
            <Tooltip content={t('agentChat.version.next')}>
                <button
                    aria-label={t('agentChat.version.next')}
                    className={STEP_BUTTON_CLASS}
                    disabled={isCurrent}
                    type="button"
                    onClick={() => versions.step(switcher, index + 1)}
                >
                    <ChevronRight aria-hidden="true" className="size-3.5" />
                </button>
            </Tooltip>
        </div>
    );
}
