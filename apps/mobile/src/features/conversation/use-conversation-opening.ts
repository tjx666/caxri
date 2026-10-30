import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { FlashListRef } from '@shopify/flash-list';

import { PANEL_ENTER_MS, segmentEnterOffset } from '../sessions/hooks/use-segment-entering';

/**
 * The longest an opening list stays hidden while older pages fill its viewport; a slow page then lands in view.
 */
const OPENING_FILL_LIMIT_MS = 1_000;

/**
 * Runs after FlashList's own deferred scroll: it resolves `scrollToEnd` before its native scroll, which it defers by
 * one task, so `run` waits for that task and then one frame.
 */
const afterScrollLands = (scroll: Promise<void> | void, run: () => void): void => {
    void Promise.resolve(scroll).finally(() => {
        setTimeout(() => requestAnimationFrame(run), 0);
    });
};

/**
 * How a `ConversationList` opens. FlashList 2.0.2 places `startRenderingFromBottom` from estimated row heights, then
 * corrects the offset over several frames while rows measure; on a Conversation of mixed-height rows that reads as the
 * list scrolling into place and blanking mid-transition. The list stays transparent until an explicit scroll to the end
 * has landed, so the first visible frame is already the settled bottom.
 * https://github.com/Shopify/flash-list/blob/v2.0.2/src/recyclerview/hooks/useRecyclerViewController.tsx
 *
 * Rows that open shorter than the viewport also stay hidden while older pages fill it (for at most
 * {@link OPENING_FILL_LIMIT_MS}): each page lands above the rows and shifts them before the list returns to its end, so
 * filling in view showed the opened Conversation jumping up and back.
 *
 * Positioning outlasts a tab switch's entering animation, so a list opened by a tab switch plays that motion itself
 * when it is revealed. Only the wrapper's opacity and transform animate; the list's own layout and measurement are
 * untouched. React Compiler memoizes the returned functions from their ref inputs.
 */
export function useConversationOpening<Entry>({
    enterFrom,
    fillWithOlder,
    isPositionedReference,
    isShort,
    list,
    measureSpacer,
    onReveal,
}: {
    enterFrom: -1 | 0 | 1 | null;
    fillWithOlder: () => void;
    /**
     * Set once the first scroll to the end has landed; the list ignores scroll events and older pages until then.
     */
    isPositionedReference: RefObject<boolean>;
    isShort: () => boolean;
    list: RefObject<FlashListRef<Entry> | null>;
    measureSpacer: () => boolean;
    /**
     * Called once the list starts to reveal itself; from then on the reader sees every row that lands.
     */
    onReveal: () => void;
}) {
    const revealProgress = useSharedValue(0);
    const enterOffset = enterFrom === null ? 0 : segmentEnterOffset(enterFrom);
    const revealStyle = useAnimatedStyle(() => ({
        opacity: revealProgress.get(),
        transform: [{ translateX: (1 - revealProgress.get()) * enterOffset }],
    }));
    const isRevealing = useRef(false);
    const fillLimit = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(fillLimit.current), []);
    const revealAtEnd = (): void => {
        if (isRevealing.current) return;
        isRevealing.current = true;
        onReveal();
        measureSpacer();
        afterScrollLands(list.current?.scrollToEnd({ animated: false }), () => {
            revealProgress.set(
                enterFrom === null ? 1 : withTiming(1, { duration: PANEL_ENTER_MS }),
            );
            fillWithOlder();
        });
    };
    /**
     * Before the list is revealed, either reads the next page its short rows still need or reveals it at its end.
     */
    const settle = (): void => {
        if (!isPositionedReference.current || isRevealing.current) return;
        if (isShort()) fillWithOlder();
        else revealAtEnd();
    };
    const onLoad = (): void => {
        measureSpacer();
        afterScrollLands(list.current?.scrollToEnd({ animated: false }), () => {
            isPositionedReference.current = true;
            fillLimit.current = setTimeout(revealAtEnd, OPENING_FILL_LIMIT_MS);
            settle();
        });
    };
    /**
     * After each layout commit: an opening list reads its next page or reveals itself, an open one keeps filling.
     */
    const onLayoutCommitted = (): void => {
        if (isRevealing.current) fillWithOlder();
        else settle();
    };
    return { onLayoutCommitted, onLoad, revealStyle };
}
