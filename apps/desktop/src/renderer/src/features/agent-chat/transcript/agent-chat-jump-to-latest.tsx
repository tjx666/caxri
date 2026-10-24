import type { RefObject } from 'react';

import { ArrowDown } from 'lucide-react';

import { ScrollFade } from '../../../components/scroll-fade';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';

/**
 * The floating "Jump to latest" control over a following scroll view (`useAgentChatScroll`), shown only while the
 * latest entry is out of view. It is a round down-arrow button without a caption, like the Codex app's: the arrow over
 * the transcript says enough, and its name stays in the accessible label and the hover tooltip. Jumping hides the
 * button, so focus would fall to the document body; it moves to `focusTarget` instead (the composer in a Chat, the
 * scroll container in a read-only task view), keeping keyboard users where they work.
 *
 * It stays mounted so it can fade and rise in on `--motion-overlay-enter` and out on `--motion-overlay-exit` like the
 * other floating surfaces; while hidden it is `inert`, so neither Tab nor a screen reader reaches it.
 *
 * The scroll view runs on under the button and dissolves into a bottom fade drawn with it (DESIGN.md "Scroll edge
 * cues"): ending the view above the button left a blank band that read as the button hiding the conversation. The fade
 * is inset by the 8px scrollbar rail so it never dims the thumb.
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
        <>
            {!isLatestInView && <ScrollFade className="right-2" edge="bottom" fill="background" />}
            <Tooltip hoverOnly content={t('agentChat.timeline.jumpToLatest')} side="top">
                <Button
                    aria-label={t('agentChat.timeline.jumpToLatest')}
                    className={cn(
                        'absolute bottom-2 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full shadow-[0_8px_24px_var(--shadow)] transition-[background,opacity,translate] motion-reduce:transition-none',
                        isLatestInView
                            ? 'pointer-events-none translate-y-1 opacity-0 duration-(--motion-overlay-exit) ease-(--motion-ease-exit)'
                            : 'translate-y-0 opacity-100 duration-(--motion-overlay-enter) ease-(--motion-ease-enter)',
                    )}
                    inert={isLatestInView}
                    size="icon"
                    variant="secondary"
                    onClick={() => {
                        onJump();
                        focusTarget.current?.focus({ preventScroll: true });
                    }}
                >
                    <ArrowDown aria-hidden="true" className="size-4" />
                </Button>
            </Tooltip>
        </>
    );
}
