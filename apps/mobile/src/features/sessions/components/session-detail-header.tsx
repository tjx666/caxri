import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import type { LucideIcon } from 'lucide-react-native';
import {
    ChevronLeft,
    EllipsisVertical,
    FileDiff,
    ListTree,
    MailOpen,
    MessagesSquare,
    SquareTerminal,
} from 'lucide-react-native';

import { AgentGlyph } from '../../../components/agent-icon';
import { IconButton } from '../../../components/icon-button';
import { PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import type { MobileTheme } from '../../../theme/tokens';
import { isAgentChatTerminal } from '../../agent-chat/agent-chat-model';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import { PanelIcon } from '../../panels/panels-view';
import type { Panel } from '../../panels/use-panels';
import type { MobileSessionItem } from '../session-model';
import type { SESSION_SEGMENTS, SessionSegment } from '../session-ui-state';
import { isPanelSessionSegment, panelIdOfSegment } from '../session-ui-state';
import { sessionDetailStyles as styles } from './session-detail-styles';
import { SessionStatusGlyph } from './session-status-glyph';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
/**
 * The selected tab grows to fit its label, so every tab animates its frame instead of snapping its neighbours aside.
 */
const tabLayoutTransition = LinearTransition.duration(200);
const tabLabelEntering = FadeIn.duration(160).delay(60);

const fixedSegmentPresentation: Record<
    (typeof SESSION_SEGMENTS)[number],
    { icon: LucideIcon; label: string }
> = {
    conversation: { icon: MessagesSquare, label: 'Conversation' },
    terminal: { icon: SquareTerminal, label: 'Terminal' },
    changes: { icon: FileDiff, label: 'Changes' },
};

const segmentPresentation = (
    segment: SessionSegment,
    panels: readonly Panel[] | undefined,
    isChat: boolean,
): { icon: LucideIcon; label: string; panel?: Panel } => {
    // A Chat's conversation tab carries the Desktop name for that surface.
    if (segment === 'conversation' && isChat) return { icon: MessagesSquare, label: 'Chat' };
    if (!isPanelSessionSegment(segment)) return fixedSegmentPresentation[segment];
    const panel = panels?.find((candidate) => candidate.id === panelIdOfSegment(segment));
    return { icon: ListTree, label: panel?.title ?? 'Project view', panel };
};

/**
 * `session-segment-panel-caxri.files` rather than the raw `panel:` segment, so test ids stay free of separators.
 */
const segmentTestId = (segment: SessionSegment): string =>
    isPanelSessionSegment(segment)
        ? `session-segment-panel-${panelIdOfSegment(segment)}`
        : `session-segment-${segment}`;

/**
 * Only the selected tab spells out its name. Several labelled tabs do not fit a phone at the default font scale, and
 * the icons stay distinct enough once one of them is named; every tab keeps its full accessible name.
 */
const SessionSegmentTab = ({
    changesCount,
    isChat,
    onPress,
    option,
    panels,
    selected,
    theme,
}: {
    changesCount: number | null;
    isChat: boolean;
    onPress: () => void;
    option: SessionSegment;
    panels: readonly Panel[] | undefined;
    selected: boolean;
    theme: MobileTheme;
}) => {
    const { icon: Icon, label, panel } = segmentPresentation(option, panels, isChat);
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
            testID={segmentTestId(option)}
        >
            {panel ? (
                <PanelIcon
                    color={color}
                    panel={panel}
                    size={18}
                    strokeWidth={selected ? 2.25 : 2}
                />
            ) : (
                <Icon color={color} size={18} strokeWidth={selected ? 2.25 : 2} />
            )}
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
    isConnected,
    onBack,
    onMarkRead,
    onSegmentChange,
    panels,
    segment,
    segments,
    session,
    theme,
}: {
    changesCount: number | null;
    isConnected: boolean;
    onBack?: () => void;
    onMarkRead: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    panels: readonly Panel[] | undefined;
    segment: SessionSegment;
    /**
     * Visible tabs in order: the fixed segments this Session supports, then one per Project view.
     */
    segments: readonly SessionSegment[];
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const menuAnchor = useRef<View>(null);
    const menu = usePopoverAnchor(menuAnchor);
    const { close: closeMenu } = menu;
    const [markReadError, setMarkReadError] = useState<string | null>(null);
    const [isTitleExpanded, setTitleExpanded] = useState(false);
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
                        {/* A long title is cut to one line; tapping it reveals the rest. */}
                        <Text
                            accessibilityHint="Shows the full title."
                            accessibilityRole="header"
                            numberOfLines={isTitleExpanded ? 3 : 1}
                            onPress={() => setTitleExpanded((current) => !current)}
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
            {/* Project views join the fixed tabs, so the strip scrolls rather than squeezing on a narrow phone. */}
            <ScrollView
                contentContainerStyle={styles.tabs}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[styles.tabStrip, { borderColor: theme.border }]}
            >
                {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A handful of tabs; virtualizing would only break the strip's layout animation. */}
                {segments.map((option) => (
                    <SessionSegmentTab
                        key={option}
                        changesCount={changesCount}
                        isChat={isAgentChatTerminal(session.primaryTerminal)}
                        onPress={() => onSegmentChange(option)}
                        option={option}
                        panels={panels}
                        selected={segment === option}
                        theme={theme}
                    />
                ))}
            </ScrollView>
        </>
    );
};
