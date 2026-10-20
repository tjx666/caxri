import type { RefObject } from 'react';

import { ArrowDown } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';

/**
 * The floating "Jump to latest" control over a following scroll view (`useAgentChatScroll`), shown only while the
 * latest entry is out of view. Jumping hides the button, so focus would fall to the document body; it moves to
 * `focusTarget` instead (the composer in a Chat, the scroll container in a read-only task view), keeping keyboard users
 * where they work.
 *
 * It stays mounted so it can fade and rise in on `--motion-overlay-enter` and out on `--motion-overlay-exit` like the
 * other floating surfaces; while hidden it is `inert`, so neither Tab nor a screen reader reaches it.
 */
export function AgentChatJumpToLatest({
    focusTarget,
    isLatestInView,
    onJump,
}: {
    focusTarget: RefObject<{ focus: (options?: FocusOptions) => void } | null>;
    isLatestInView: boolean;
    onJump: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Button
            className={cn(
                'absolute bottom-2 left-1/2 -translate-x-1/2 shadow-[0_8px_24px_var(--shadow)] transition-[background,opacity,translate] motion-reduce:transition-none',
                isLatestInView
                    ? 'pointer-events-none translate-y-1 opacity-0 duration-(--motion-overlay-exit) ease-(--motion-ease-exit)'
                    : 'translate-y-0 opacity-100 duration-(--motion-overlay-enter) ease-(--motion-ease-enter)',
            )}
            inert={isLatestInView}
            size="sm"
            variant="secondary"
            onClick={() => {
                onJump();
                focusTarget.current?.focus({ preventScroll: true });
            }}
        >
            <ArrowDown aria-hidden="true" className="size-3.5" />
            {t('agentChat.timeline.jumpToLatest')}
        </Button>
    );
}
