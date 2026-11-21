import type { ReactNode, RefObject } from 'react';
import { useMemo, useState } from 'react';

import type { FlashListRef } from '@shopify/flash-list';

import type { MobileTheme } from '../../../theme/tokens';
import { ConversationJumpMessages } from '../conversation-jump-latest';
import type { ConversationFollower } from '../conversation-scroll';
import { CONVERSATION_TURN_TOP_GAP } from '../conversation-scroll';
import type { ConversationMessageMark } from './conversation-message-index';
import {
    activeConversationMessage,
    conversationMessageMarks,
    isConversationMessageIndexShown,
} from './conversation-message-index';
import { ConversationMessageIndexSheet } from './conversation-message-index-sheet';

/**
 * The Messages button above Jump to latest and the sheet it opens. It reads where the reader is from the list when the
 * sheet opens, and a picked row rests that message at the top of the viewport, as a sent message rests. The list stops
 * following first, so new output does not pull the reader back to the end mid-jump.
 */
export const ConversationMessageIndexControl = <Entry extends { id: string }>({
    entries,
    follower,
    header,
    isButtonShown,
    list,
    messagePreview,
    onLeaveEnd,
    theme,
}: {
    entries: readonly Entry[];
    follower: Pick<ConversationFollower, 'hold' | 'isFollowing'>;
    /**
     * The Conversation's load-earlier row, repeated at the sheet's top.
     */
    header: ReactNode;
    /**
     * Whether the reader is away from the end, where Jump to latest shows too.
     */
    isButtonShown: boolean;
    list: RefObject<FlashListRef<Entry> | null>;
    messagePreview: (entry: Entry) => string | undefined;
    /**
     * Tells the list a jump left its end, so Jump to latest returns.
     */
    onLeaveEnd: () => void;
    theme: MobileTheme;
}) => {
    const jump = (mark: ConversationMessageMark): void => {
        follower.hold();
        onLeaveEnd();
        void list.current?.scrollToIndex({
            animated: true,
            index: mark.index,
            viewOffset: -CONVERSATION_TURN_TOP_GAP,
        });
    };
    /**
     * The message the reader was in when the sheet opened, or `undefined` while it is closed. It is kept by id so a
     * page of older messages loaded from the sheet's header does not move the mark to another message.
     */
    const [openAt, setOpenAt] = useState<{ activeId: string | undefined }>();
    // Built only while the sheet is open: every streamed patch hands the list new entries.
    const marks = useMemo(
        () => (openAt ? conversationMessageMarks(entries, messagePreview) : []),
        [entries, messagePreview, openAt],
    );
    const open = (): void => {
        const opened = conversationMessageMarks(entries, messagePreview);
        const active = activeConversationMessage(
            opened,
            list.current?.getFirstVisibleIndex() ?? 0,
            follower.isFollowing,
        );
        setOpenAt({ activeId: opened[active]?.id });
    };
    return (
        <>
            {isButtonShown && isConversationMessageIndexShown(entries, messagePreview) ? (
                <ConversationJumpMessages onPress={open} theme={theme} />
            ) : null}
            {openAt ? (
                <ConversationMessageIndexSheet
                    activeIndex={marks.findIndex((mark) => mark.id === openAt.activeId)}
                    header={header}
                    marks={marks}
                    onClose={() => setOpenAt(undefined)}
                    onSelect={jump}
                    theme={theme}
                />
            ) : null}
        </>
    );
};
