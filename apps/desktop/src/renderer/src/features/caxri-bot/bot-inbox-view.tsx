import { useEffect, useRef } from 'react';

import type { BotInboxItem } from '@caxri/protocol';
import { X } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { describeFailure } from '../../stores/toasts';
import { botInboxSections, inboxReplyTarget } from './bot-inbox';
import { BotInboxCard } from './bot-inbox-card';
import { BotInboxComposer } from './bot-inbox-composer';
import {
    setBotInboxVisible,
    settleBotInboxFocusRequest,
    useBotInboxUiStore,
} from './bot-inbox-store';
import { useBotInbox } from './hooks/use-bot-inbox';

/**
 * The "Needs you" column: what Caxri Bot explicitly raised for the owner, questions first, then pull requests it
 * verified as ready to merge, with one reply box under them.
 */
export function BotInboxView() {
    const { t } = useTranslation();
    const inbox = useBotInbox();
    const { data } = inbox;
    return (
        <>
            <div className="flex h-9 flex-none items-center gap-2 px-3">
                <h2 className="m-0 text-[12px] font-medium">{t('caxriBot.window.needsYou')}</h2>
                <Tooltip content={t('caxriBot.window.hideNeedsYou')}>
                    <button
                        type="button"
                        aria-label={t('caxriBot.window.hideNeedsYou')}
                        className="ml-auto flex size-5 cursor-pointer items-center justify-center rounded-md text-muted hover:text-foreground"
                        onClick={() => setBotInboxVisible(false)}
                    >
                        <X size={13} />
                    </button>
                </Tooltip>
            </div>
            {!data && inbox.isError && (
                <div className="bot-inbox-status flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
                    <span>{describeFailure(inbox.error, t('caxriBot.inbox.loadFailed'), t)}</span>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            // Fire-and-forget: a failed retry lands back in this same error state.
                            void inbox.refetch();
                        }}
                    >
                        {t('common.retry')}
                    </Button>
                </div>
            )}
            {!data && !inbox.isError && (
                <LoadingSkeleton
                    variant="list"
                    className="bot-inbox-status min-h-0 flex-1 py-1"
                    label={t('caxriBot.inbox.loading')}
                />
            )}
            {data && <BotInboxList generatedAt={data.generatedAt} items={data.items} />}
        </>
    );
}

function BotInboxList({
    generatedAt,
    items,
}: {
    generatedAt: number;
    items: readonly BotInboxItem[];
}) {
    const { t } = useTranslation();
    const targetId = useBotInboxUiStore((state) => state.targetId);
    const dismissingIds = useBotInboxUiStore((state) => state.dismissingIds);
    const visibleItems = items.filter((item) => !Object.hasOwn(dismissingIds, item.id));
    const target = inboxReplyTarget(visibleItems, targetId);
    const sections = botInboxSections(visibleItems, t);
    const listReference = useRef<HTMLDivElement>(null);
    const isFocusRequested = useBotInboxUiStore((state) => state.isFocusRequested);
    useEffect(() => {
        if (!isFocusRequested) return;
        const first = listReference.current?.querySelector<HTMLElement>('.bot-inbox-item');
        // The pointer was in the Workbench, so ask for the focus ring Chromium would otherwise withhold after a click.
        first?.focus({ focusVisible: true });
        first?.scrollIntoView({ block: 'nearest' });
        settleBotInboxFocusRequest();
    }, [isFocusRequested]);
    return (
        <>
            {sections.length === 0 ? (
                // No Hand Over action here: the title bar's Hand Over… button is always beside this column, and the
                // board's empty state already offers it where a first-time user looks for work to give Caxri Bot.
                <div className="bot-inbox-empty flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
                    <span>{t('caxriBot.inbox.empty')}</span>
                </div>
            ) : (
                <div
                    className="bot-inbox min-h-0 flex-1 overflow-auto px-2 pb-2"
                    data-keeps-keyboard-focus="true"
                    ref={listReference}
                >
                    {sections.map((section) => (
                        <section
                            key={section.id}
                            aria-label={section.title}
                            className="bot-inbox-section mt-1 flex flex-col gap-1.5"
                            data-inbox-section={section.id}
                        >
                            <h3 className="m-0 px-1 pt-1 text-[11px] font-medium text-muted">
                                {section.title} · {section.items.length}
                            </h3>
                            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                                {section.items.map((item) => (
                                    <BotInboxCard
                                        key={item.id}
                                        isTarget={item.id === target?.id}
                                        item={item}
                                        now={generatedAt}
                                    />
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
            {sections.length > 0 && <BotInboxComposer items={items} />}
        </>
    );
}
