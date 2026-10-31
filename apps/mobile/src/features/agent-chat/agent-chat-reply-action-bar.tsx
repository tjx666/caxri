/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { use, useRef, useState } from 'react';
import type { HostInstance } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatWebSource } from '@caxri/protocol';
import { Copy, Ellipsis, GitFork, RotateCcw, Share2, TextCursor } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import {
    PopoverAction,
    PopoverDivider,
    PopoverHeading,
    PopoverMenu,
} from '../../components/popover-menu';
import { usePopoverAnchor } from '../../components/use-popover-anchor';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';
import { agentChatReplyTime } from './agent-chat-reply-actions';
import { AgentChatSourceFavicon, AgentChatSourcesSheet } from './agent-chat-sources-sheet';
import type { AgentChatReplyAction } from './use-agent-chat-reply-actions';
import { AgentChatReplyActionsContext } from './use-agent-chat-reply-actions';

const ICON_SIZE = 18;
/**
 * Sites the Sources button stacks before its label, as the ChatGPT app shows three.
 */
const STACKED_SOURCES = 3;
const FAVICON_SIZE = 22;

/**
 * The More menu's state while open: the actions as they stood when it opened, and the time it heads itself with.
 */
interface MoreMenu {
    sentAt?: string;
    fork?: AgentChatReplyAction;
    retry?: AgentChatReplyAction;
}

/**
 * The bar under a reply that ends a turn, laid out as the Codex and ChatGPT apps end a reply: Copy, Share, and More on
 * the left, and after them the pages the turn searched or fetched, stacked as site icons beside `Sources`. More heads
 * its menu with when the reply was sent, since nothing else in the timeline says so, then offers Fork in New Chat,
 * Retry, and Select Text; an action that cannot run now stays listed, dimmed with its reason.
 */
export const AgentChatReplyActionBar = ({
    replyId,
    sentAt,
    sources,
    theme,
    turnId,
}: {
    replyId: string;
    sentAt?: number;
    sources: readonly AgentChatWebSource[];
    theme: MobileTheme;
    turnId: string;
}) => {
    const { locale, t } = useTranslation();
    const handlers = use(AgentChatReplyActionsContext);
    const moreAnchor = useRef<HostInstance>(null);
    const popover = usePopoverAnchor(moreAnchor, { align: 'start', side: 'auto' });
    const [menu, setMenu] = useState<MoreMenu>();
    const [isSourcesOpen, setSourcesOpen] = useState(false);
    if (!handlers) return null;
    const openMenu = () => {
        setMenu({
            ...(sentAt !== undefined && {
                sentAt: agentChatReplyTime(sentAt, Date.now(), locale, t),
            }),
            fork: handlers.fork(turnId),
            retry: handlers.retry(turnId),
        });
        popover.open();
    };
    const closeMenu = () => {
        popover.close();
        setMenu(undefined);
    };
    const runFromMenu = (run: () => void) => {
        closeMenu();
        run();
    };
    const reason = (action: AgentChatReplyAction) =>
        action.availability.canRun ? undefined : action.availability.reason;
    return (
        <View
            accessibilityLabel={t('chat.reply.actions')}
            style={[conversationStyles.message, styles.bar]}
            testID={`agent-chat-reply-actions-${turnId}`}
        >
            <View style={styles.buttons}>
                <IconButton
                    accessibilityLabel={t('chat.reply.copy')}
                    color={theme.muted}
                    icon={Copy}
                    onPress={() => handlers.copy(replyId)}
                    size={ICON_SIZE}
                    testID={`agent-chat-reply-copy-${turnId}`}
                    theme={theme}
                />
                <IconButton
                    accessibilityLabel={t('chat.reply.share')}
                    color={theme.muted}
                    icon={Share2}
                    onPress={() => handlers.share(replyId)}
                    size={ICON_SIZE}
                    testID={`agent-chat-reply-share-${turnId}`}
                    theme={theme}
                />
                <View collapsable={false} ref={moreAnchor}>
                    <IconButton
                        accessibilityLabel={t('chat.reply.more')}
                        color={theme.muted}
                        expanded={popover.isOpen}
                        icon={Ellipsis}
                        onPress={openMenu}
                        size={ICON_SIZE}
                        testID={`agent-chat-reply-more-${turnId}`}
                        theme={theme}
                    />
                </View>
            </View>
            {sources.length > 0 ? (
                <Pressable
                    accessibilityLabel={`${t('chat.reply.sources')} (${sources.length})`}
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => setSourcesOpen(true)}
                    style={({ pressed }) => [styles.sources, pressed && styles.pressed]}
                    testID={`agent-chat-reply-sources-${turnId}`}
                >
                    <View style={styles.stack}>
                        {sources.slice(0, STACKED_SOURCES).map((source, index) => (
                            <View key={source.url} style={index > 0 ? styles.stacked : undefined}>
                                <AgentChatSourceFavicon
                                    ring={theme.background}
                                    size={FAVICON_SIZE}
                                    theme={theme}
                                    url={source.url}
                                />
                            </View>
                        ))}
                    </View>
                    <Text style={[mobileType.meta, { color: theme.muted }]}>
                        {t('chat.reply.sources')}
                    </Text>
                </Pressable>
            ) : null}
            <PopoverMenu
                closeLabel={t('common.close')}
                onClose={closeMenu}
                placement={popover.placement}
                theme={theme}
            >
                {menu?.sentAt ? (
                    <>
                        <PopoverHeading
                            label={menu.sentAt}
                            testID="agent-chat-reply-time"
                            theme={theme}
                        />
                        <PopoverDivider theme={theme} />
                    </>
                ) : null}
                {menu ? (
                    <>
                        {menu.fork ? (
                            <PopoverAction
                                detail={reason(menu.fork)}
                                disabled={!menu.fork.availability.canRun}
                                icon={GitFork}
                                label={t('chat.reply.fork')}
                                onPress={() => runFromMenu(menu.fork?.run ?? (() => {}))}
                                testID="agent-chat-reply-fork"
                                theme={theme}
                            />
                        ) : null}
                        {menu.retry ? (
                            <PopoverAction
                                detail={reason(menu.retry)}
                                disabled={!menu.retry.availability.canRun}
                                icon={RotateCcw}
                                label={t('chat.reply.retry')}
                                onPress={() => runFromMenu(menu.retry?.run ?? (() => {}))}
                                testID="agent-chat-reply-retry"
                                theme={theme}
                            />
                        ) : null}
                        <PopoverAction
                            icon={TextCursor}
                            label={t('conversation.message.selectText')}
                            onPress={() => runFromMenu(() => handlers.selectText(replyId))}
                            testID="agent-chat-reply-select"
                            theme={theme}
                        />
                    </>
                ) : null}
            </PopoverMenu>
            {isSourcesOpen ? (
                <AgentChatSourcesSheet
                    onClose={() => setSourcesOpen(false)}
                    sources={sources}
                    theme={theme}
                />
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    bar: {
        alignItems: 'center',
        flexDirection: 'row',
        // The first glyph lines up with the reply's text; its 44dp touch target reaches into the gutter.
        marginLeft: -12,
        marginTop: -mobileSpace.xs,
    },
    buttons: { alignItems: 'center', flexDirection: 'row' },
    pressed: { opacity: 0.6 },
    sources: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        marginLeft: mobileSpace.sm,
        paddingVertical: mobileSpace.xs,
    },
    stack: { flexDirection: 'row' },
    stacked: { marginLeft: -8 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
