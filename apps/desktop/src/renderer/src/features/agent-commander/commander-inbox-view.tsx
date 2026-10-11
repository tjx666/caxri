import type { CommanderInboxItem } from '@caxri/protocol';
import { X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { describeFailure } from '../../stores/toasts';
import { commanderInboxSections, inboxReplyTarget } from './commander-inbox';
import { CommanderInboxCard } from './commander-inbox-card';
import { CommanderInboxComposer } from './commander-inbox-composer';
import { setCommanderInboxVisible, useCommanderInboxUiStore } from './commander-inbox-store';
import { useCommanderInbox } from './hooks/use-commander-inbox';

/**
 * The "Needs you" column: what the Commander explicitly raised for the owner, questions first, then pull requests it
 * verified as ready to merge, with one reply box under them.
 */
export function CommanderInboxView() {
    const inbox = useCommanderInbox();
    const { data } = inbox;
    return (
        <>
            <div className="flex h-9 flex-none items-center gap-2 px-3">
                <h2 className="m-0 text-[12px] font-medium">Needs you</h2>
                <Tooltip content="Hide this column">
                    <button
                        type="button"
                        aria-label="Hide Needs you"
                        className="ml-auto flex size-5 cursor-pointer items-center justify-center rounded text-muted hover:text-foreground"
                        onClick={() => setCommanderInboxVisible(false)}
                    >
                        <X size={13} />
                    </button>
                </Tooltip>
            </div>
            {!data && inbox.isError && (
                <div className="commander-inbox-status flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
                    <span>{describeFailure(inbox.error, 'Unable to load the Inbox')}</span>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            // Fire-and-forget: a failed retry lands back in this same error state.
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                            void inbox.refetch();
                        }}
                    >
                        Retry
                    </Button>
                </div>
            )}
            {!data && !inbox.isError && (
                <div className="commander-inbox-status flex min-h-0 flex-1 items-center justify-center p-6 text-muted">
                    <Spinner />
                </div>
            )}
            {data && <CommanderInboxList generatedAt={data.generatedAt} items={data.items} />}
        </>
    );
}

function CommanderInboxList({
    generatedAt,
    items,
}: {
    generatedAt: number;
    items: readonly CommanderInboxItem[];
}) {
    const targetId = useCommanderInboxUiStore((state) => state.targetId);
    const target = inboxReplyTarget(items, targetId);
    const sections = commanderInboxSections(items);
    return (
        <>
            {sections.length === 0 ? (
                <div className="commander-inbox-empty flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted">
                    Nothing needs you. When the Commander has a question or a pull request ready to
                    merge, it appears here.
                </div>
            ) : (
                <div className="commander-inbox min-h-0 flex-1 overflow-auto px-2 pb-2">
                    {sections.map((section) => (
                        <section
                            key={section.id}
                            aria-label={section.title}
                            className="commander-inbox-section mt-1 flex flex-col gap-1.5"
                            data-inbox-section={section.id}
                        >
                            <h3 className="m-0 px-1 pt-1 text-[11px] font-medium text-muted">
                                {section.title} · {section.items.length}
                            </h3>
                            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                                {section.items.map((item) => (
                                    <CommanderInboxCard
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
            {sections.length > 0 && <CommanderInboxComposer items={items} />}
        </>
    );
}
