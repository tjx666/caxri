import { useCallback, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import type { LucideIcon } from 'lucide-react-native';
import {
    ChevronLeft,
    EllipsisVertical,
    FileDiff,
    FolderGit2,
    MailOpen,
    MessagesSquare,
    SquareTerminal,
} from 'lucide-react-native';

import { AgentGlyph } from '../../../components/agent-icon';
import { IconButton } from '../../../components/icon-button';
import { PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import type { MobileTheme } from '../../../theme/tokens';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import type { MobileSessionItem } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { SESSION_SEGMENTS } from '../session-ui-state';
import { sessionDetailStyles as styles } from './session-detail-styles';
import { SessionStatusGlyph } from './session-status-glyph';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
/**
 * The selected tab grows to fit its label, so every tab animates its frame instead of snapping its neighbours aside.
 */
const tabLayoutTransition = LinearTransition.duration(200);
const tabLabelEntering = FadeIn.duration(160).delay(60);

const segmentPresentation: Record<SessionSegment, { icon: LucideIcon; label: string }> = {
    conversation: { icon: MessagesSquare, label: 'Conversation' },
    terminal: { icon: SquareTerminal, label: 'Terminal' },
    changes: { icon: FileDiff, label: 'Changes' },
    panels: { icon: FolderGit2, label: 'Project' },
};

/**
 * Only the selected tab spells out its name. Four labelled tabs do not fit a phone at the default font scale, and the
 * icons stay distinct enough once one of them is named; every tab keeps its full accessible name.
 */
const SessionSegmentTab = ({
    changesCount,
    onPress,
    option,
    selected,
    theme,
}: {
    changesCount: number | null;
    onPress: () => void;
    option: SessionSegment;
    selected: boolean;
    theme: MobileTheme;
}) => {
    const { icon: Icon, label } = segmentPresentation[option];
    /**
     * A zero badge reads as a value to act on; an empty Changes tab says the same thing without the noise.
     */
    const count = option === 'changes' && changesCount ? changesCount : null;
    const color = selected ? theme.text : theme.muted;
    return (
        <AnimatedPressable
            accessibilityLabel={count === null ? label : `${label}, ${count}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            layout={tabLayoutTransition}
            onPress={onPress}
            style={[styles.tab, selected ? { backgroundColor: theme.surface } : null]}
            testID={`session-segment-${option}`}
        >
            <Icon color={color} size={18} strokeWidth={selected ? 2.25 : 2} />
            {selected ? (
                <Animated.Text
                    entering={tabLabelEntering}
                    numberOfLines={1}
                    style={[styles.tabText, { color }]}
                >
                    {label}
                </Animated.Text>
            ) : null}
            {count === null ? null : (
                <Text
                    style={[
                        styles.tabBadge,
                        {
                            backgroundColor: theme.elevated,
                            color,
                        },
                    ]}
                    testID="changes-count"
                >
                    {count}
                </Text>
            )}
        </AnimatedPressable>
    );
};

export const SessionDetailHeader = ({
    changesCount,
    hasConversation,
    isConnected,
    onBack,
    onMarkRead,
    onSegmentChange,
    segment,
    session,
    theme,
}: {
    changesCount: number | null;
    hasConversation: boolean;
    isConnected: boolean;
    onBack?: () => void;
    onMarkRead: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    segment: SessionSegment;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const menuAnchor = useRef<View>(null);
    const menu = usePopoverAnchor(menuAnchor);
    const { close: closeMenu } = menu;
    const [markReadError, setMarkReadError] = useState<string | null>(null);
    const handleMarkRead = useCallback(async (): Promise<void> => {
        closeMenu();
        try {
            await onMarkRead();
            setMarkReadError(null);
        } catch (error) {
            setMarkReadError(
                error instanceof MobileGatewayRequestError && error.code === 'FORBIDDEN'
                    ? 'This device cannot mark Sessions as read. Pair it again on your computer to grant control.'
                    : 'Unable to mark this Session as read.',
            );
        }
    }, [closeMenu, onMarkRead]);
    return (
        <>
            <View style={[styles.header, { borderColor: theme.border }]}>
                <View style={styles.headerLine}>
                    {onBack ? (
                        <IconButton
                            accessibilityHint="Returns to the Session list."
                            accessibilityLabel="Back to Sessions"
                            icon={ChevronLeft}
                            onPress={onBack}
                            size={26}
                            testID="session-detail-back"
                            theme={theme}
                        />
                    ) : null}
                    <View style={styles.titleGroup}>
                        <AgentGlyph kind={session.primaryTerminal?.kind} size={18} theme={theme} />
                        <Text
                            accessibilityRole="header"
                            numberOfLines={1}
                            style={[styles.title, { color: theme.text }]}
                            testID="session-detail-title"
                        >
                            {session.displayTitle}
                        </Text>
                        <SessionStatusGlyph session={session} theme={theme} />
                    </View>
                    <View collapsable={false} ref={menuAnchor}>
                        <IconButton
                            accessibilityLabel="Session menu"
                            expanded={menu.isOpen}
                            icon={EllipsisVertical}
                            onPress={menu.open}
                            testID="session-detail-menu"
                            theme={theme}
                        />
                    </View>
                </View>
                <PopoverMenu
                    closeLabel="Close Session menu"
                    onClose={closeMenu}
                    placement={menu.placement}
                    theme={theme}
                >
                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !isConnected }}
                        disabled={!isConnected}
                        onPress={handleMarkRead}
                        style={styles.menuAction}
                        testID="session-mark-read"
                    >
                        <MailOpen color={theme.muted} size={18} />
                        <Text
                            style={[
                                styles.menuActionText,
                                { color: isConnected ? theme.text : theme.muted },
                            ]}
                        >
                            Mark read
                        </Text>
                    </Pressable>
                    {!isConnected ? (
                        <Text style={[styles.sendState, { color: theme.muted }]}>
                            Reconnect to mark read.
                        </Text>
                    ) : null}
                </PopoverMenu>
                {markReadError ? (
                    <Text
                        accessibilityRole="alert"
                        style={[styles.sendState, { color: theme.danger }]}
                    >
                        {markReadError}
                    </Text>
                ) : null}
            </View>
            <View style={[styles.tabs, { borderColor: theme.border }]}>
                {(hasConversation
                    ? SESSION_SEGMENTS
                    : SESSION_SEGMENTS.filter((option) => option !== 'conversation')
                ).map((option) => (
                    <SessionSegmentTab
                        key={option}
                        changesCount={changesCount}
                        onPress={() => onSegmentChange(option)}
                        option={option}
                        selected={segment === option}
                        theme={theme}
                    />
                ))}
            </View>
        </>
    );
};
