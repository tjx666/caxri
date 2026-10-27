import { useCallback, useRef } from 'react';
import type { HostInstance } from 'react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
    Activity,
    Archive,
    EllipsisVertical,
    FolderPlus,
    Gauge,
    MessageSquareWarning,
    Settings,
    Unlink,
} from 'lucide-react-native';

import { IconButton } from '../../../components/icon-button';
import { PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import type { useSessionPolling } from '../hooks/use-session-polling';

type Project = ReturnType<typeof useSessionPolling>['projects'][number];
interface ProjectChoice {
    title: string;
    id: string | null;
}

const styles = StyleSheet.create({
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        minHeight: 60,
        paddingLeft: 18,
        paddingRight: 6,
    },
    heading: { flexShrink: 1, fontSize: 20, fontWeight: '700' },
    connectionDot: { borderRadius: 4, height: 8, marginRight: 10, width: 8 },
    headingRow: { alignItems: 'center', flex: 1, flexDirection: 'row', minWidth: 0 },
    menuAction: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 14,
    },
    menuText: { fontSize: 15 },
    chips: { gap: 8, paddingBottom: 6, paddingHorizontal: 14, paddingTop: 2 },
    chipsScroll: { flexGrow: 0 },
    chip: {
        borderRadius: 18,
        justifyContent: 'center',
        minHeight: 34,
        paddingHorizontal: 14,
    },
    chipText: { fontSize: 13, fontWeight: '600' },
});

const MenuAction = ({
    icon: Icon,
    isDestructive = false,
    label,
    onPress,
    testID,
    theme,
}: {
    icon: typeof Archive;
    isDestructive?: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
            styles.menuAction,
            { backgroundColor: pressed ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        <Icon color={isDestructive ? theme.danger : theme.muted} size={18} />
        <Text style={[styles.menuText, { color: isDestructive ? theme.danger : theme.text }]}>
            {label}
        </Text>
    </Pressable>
);

export const SessionHomeHeader = ({
    activeProjectId,
    hostDisplayName,
    onAddProject,
    onChooseProject,
    onForgetComputer,
    onOpenArchived,
    onOpenInbox,
    onOpenSettings,
    onOpenStatus,
    onOpenUsage,
    projects,
    status,
    theme,
}: {
    activeProjectId: string | null;
    hostDisplayName: string;
    /**
     * Present only for a control device; view and reply devices cannot widen their own Project grant.
     */
    onAddProject?: () => void;
    onChooseProject: (projectId: string | null) => void;
    onForgetComputer: () => void;
    onOpenArchived: () => void;
    /**
     * Present only for a control device: the Bot Inbox spans every Project, beyond a narrower device grant.
     */
    onOpenInbox?: () => void;
    onOpenSettings: () => void;
    /**
     * Present only for a control device: computer status names Sessions from every Project.
     */
    onOpenStatus?: () => void;
    /**
     * Opens the Agent usage screen: plan limits, output speed, and API status, one tap from home.
     */
    onOpenUsage: () => void;
    projects: Project[];
    status: MobileConnectionStatus;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const menuAnchor = useRef<HostInstance>(null);
    const menu = usePopoverAnchor(menuAnchor);
    const { close: closeMenu } = menu;
    const projectChoices: ProjectChoice[] = [
        { id: null, title: t('sessions.home.allProjects') },
        ...projects,
    ];
    const renderProject = useCallback(
        ({ item }: { item: ProjectChoice }) => {
            const isSelected = activeProjectId === item.id;
            return (
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    hitSlop={{ bottom: 7, top: 7 }}
                    onPress={() => onChooseProject(item.id)}
                    style={[
                        styles.chip,
                        { backgroundColor: isSelected ? theme.primary : theme.surface },
                    ]}
                    testID={`project-filter-${item.id ?? 'all'}`}
                >
                    <Text
                        style={[
                            styles.chipText,
                            { color: isSelected ? theme.primaryForeground : theme.text },
                        ]}
                    >
                        {item.title}
                    </Text>
                </Pressable>
            );
        },
        [activeProjectId, onChooseProject, theme],
    );
    return (
        <>
            <View style={styles.header}>
                <View style={styles.headingRow}>
                    <View
                        accessibilityLabel={t(
                            status === 'connected'
                                ? 'sessions.home.connected'
                                : 'sessions.home.notConnected',
                        )}
                        accessible
                        style={[
                            styles.connectionDot,
                            {
                                backgroundColor:
                                    status === 'connected' ? theme.success : theme.muted,
                            },
                        ]}
                    />
                    <Text
                        accessibilityRole="header"
                        numberOfLines={1}
                        style={[styles.heading, { color: theme.text }]}
                    >
                        {hostDisplayName}
                    </Text>
                </View>
                <IconButton
                    accessibilityHint={t('usage.openHint')}
                    accessibilityLabel={t('usage.open')}
                    icon={Gauge}
                    onPress={onOpenUsage}
                    testID="agent-usage-action"
                    theme={theme}
                />
                <View collapsable={false} ref={menuAnchor}>
                    <IconButton
                        accessibilityHint={t('sessions.home.computerMenuHint')}
                        accessibilityLabel={t('sessions.home.computerMenu')}
                        expanded={menu.isOpen}
                        icon={EllipsisVertical}
                        onPress={menu.open}
                        testID="forget-device-button"
                        theme={theme}
                    />
                </View>
            </View>
            <PopoverMenu
                closeLabel={t('sessions.home.closeComputerMenu')}
                onClose={closeMenu}
                placement={menu.placement}
                theme={theme}
            >
                {onAddProject ? (
                    <MenuAction
                        icon={FolderPlus}
                        label={t('sessions.home.addProject')}
                        onPress={() => {
                            closeMenu();
                            onAddProject();
                        }}
                        testID="add-project-action"
                        theme={theme}
                    />
                ) : null}
                {onOpenInbox ? (
                    <MenuAction
                        icon={MessageSquareWarning}
                        label={t('sessions.home.needsYou')}
                        onPress={() => {
                            closeMenu();
                            onOpenInbox();
                        }}
                        testID="bot-inbox-action"
                        theme={theme}
                    />
                ) : null}
                {onOpenStatus ? (
                    <MenuAction
                        icon={Activity}
                        label={t('sessions.home.computerStatus')}
                        onPress={() => {
                            closeMenu();
                            onOpenStatus();
                        }}
                        testID="computer-status-action"
                        theme={theme}
                    />
                ) : null}
                <MenuAction
                    icon={Archive}
                    label={t('sessions.home.archivedSessions')}
                    onPress={() => {
                        closeMenu();
                        onOpenArchived();
                    }}
                    testID="archived-sessions-action"
                    theme={theme}
                />
                <MenuAction
                    icon={Settings}
                    label={t('sessions.home.settings')}
                    onPress={() => {
                        closeMenu();
                        onOpenSettings();
                    }}
                    testID="settings-action"
                    theme={theme}
                />
                <MenuAction
                    icon={Unlink}
                    isDestructive
                    label={t('sessions.home.forgetComputer')}
                    onPress={() => {
                        closeMenu();
                        onForgetComputer();
                    }}
                    testID="forget-computer-menu-action"
                    theme={theme}
                />
            </PopoverMenu>
            <FlatList
                contentContainerStyle={styles.chips}
                data={projectChoices}
                horizontal
                keyExtractor={(item) => item.id ?? 'all'}
                renderItem={renderProject}
                showsHorizontalScrollIndicator={false}
                style={styles.chipsScroll}
                testID="session-project-filters"
            />
        </>
    );
};
