import type { RefObject } from 'react';

import { ArrowDown } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';

/**
 * The floating "Jump to latest" control over a following scroll view (`useAgentChatScroll`), shown only while the user
 * reads history. Jumping hides the button, so focus would fall to the document body; it moves to `focusTarget` instead
 * (the composer in a Chat, the scroll container in a read-only task view), keeping keyboard users where they work.
 */
export function AgentChatJumpToLatest({
    focusTarget,
    isFollowing,
    onJump,
}: {
    focusTarget: RefObject<HTMLElement | null>;
    isFollowing: boolean;
    onJump: () => void;
}) {
    const { t } = useTranslation();
    if (isFollowing) return null;
    return (
        <Button
            className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-md"
            size="sm"
            variant="secondary"
            onClick={() => {
                onJump();
                focusTarget.current?.focus({ preventScroll: true });
            }}
        >
            <ArrowDown className="size-3.5" />
            {t('agentChat.timeline.jumpToLatest')}
        </Button>
    );
}
