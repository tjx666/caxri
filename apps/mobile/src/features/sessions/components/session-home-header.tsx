import { useCallback, useRef } from 'react';
import type { HostInstance } from 'react-native';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import {
    Activity,
    Archive,
    EllipsisVertical,
    FolderPlus,
    Gauge,
    MessageSquareWarning,
    Settings,
} from 'lucide-react-native';

import { Chip } from '../../../components/chip';
import { IconButton } from '../../../components/icon-button';
import { PopoverAction, PopoverDivider, PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import { useTranslation } from '../../../i18n';
import { mobileSpace, mobileType } from '../../../theme/scale';
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
        paddingLeft: mobileSpace.lg,
        paddingRight: mobileSpace.xs,
    },
    heading: { ...mobileType.title, flexShrink: 1 },
    connectionDot: { borderRadius: 4, height: 8, marginRight: mobileSpace.md, width: 8 },
    headingRow: { alignItems: 'center', flex: 1, flexDirection: 'row', minWidth: 0 },
    chips: {
        gap: mobileSpace.sm,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.xs,
    },
    chipsScroll: { flexGrow: 0 },
});

export const SessionHomeHeader = ({
    activeProjectId,
    hostDisplayName,
    onAddProject,
    onChooseProject,
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
     * Opens the Agent usage screen: plan limits, output speed, and API status.
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
                <Chip
                    accessibilityLabel={item.title}
                    label={item.title}
                    onPress={() => onChooseProject(item.id)}
                    selected={isSelected}
                    testID={`project-filter-${item.id ?? 'all'}`}
                    theme={theme}
                />
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
                <View collapsable={false} ref={menuAnchor}>
                    <IconButton
                        accessibilityHint={t('sessions.home.computerMenuHint')}
                        accessibilityLabel={t('sessions.home.computerMenu')}
                        expanded={menu.isOpen}
                        icon={EllipsisVertical}
                        onPress={menu.open}
                        testID="computer-menu-button"
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
                {onOpenInbox ? (
                    <PopoverAction
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
                <PopoverAction
                    accessibilityHint={t('usage.openHint')}
                    icon={Gauge}
                    label={t('usage.open')}
                    onPress={() => {
                        closeMenu();
                        onOpenUsage();
                    }}
                    testID="agent-usage-action"
                    theme={theme}
                />
                {onOpenStatus ? (
                    <PopoverAction
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
                <PopoverDivider theme={theme} />
                <PopoverAction
                    icon={Archive}
                    label={t('sessions.home.archivedSessions')}
                    onPress={() => {
                        closeMenu();
                        onOpenArchived();
                    }}
                    testID="archived-sessions-action"
                    theme={theme}
                />
                {onAddProject ? (
                    <PopoverAction
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
                <PopoverDivider theme={theme} />
                <PopoverAction
                    icon={Settings}
                    label={t('sessions.home.settings')}
                    onPress={() => {
                        closeMenu();
                        onOpenSettings();
                    }}
                    testID="settings-action"
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
