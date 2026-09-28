import { useCallback, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Archive, EllipsisVertical, FolderPlus, Settings, Unlink } from 'lucide-react-native';

import { IconButton } from '../../../components/icon-button';
import { PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import type { useSessionPolling } from '../hooks/use-session-polling';

type Project = ReturnType<typeof useSessionPolling>['projects'][number];
interface ProjectChoice {
    displayTitle: string;
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
    onOpenSettings,
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
    onOpenSettings: () => void;
    projects: Project[];
    status: MobileConnectionStatus;
    theme: MobileTheme;
}) => {
    const menuAnchor = useRef<View>(null);
    const menu = usePopoverAnchor(menuAnchor);
    const { close: closeMenu } = menu;
    const projectChoices: ProjectChoice[] = [{ id: null, displayTitle: 'All' }, ...projects];
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
                        {item.displayTitle}
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
                        accessibilityLabel={status === 'connected' ? 'Connected' : 'Not connected'}
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
                        accessibilityHint="Opens computer actions."
                        accessibilityLabel="Computer menu"
                        expanded={menu.isOpen}
                        icon={EllipsisVertical}
                        onPress={menu.open}
                        testID="forget-device-button"
                        theme={theme}
                    />
                </View>
            </View>
            <PopoverMenu
                closeLabel="Close computer menu"
                onClose={closeMenu}
                placement={menu.placement}
                theme={theme}
            >
                {onAddProject ? (
                    <MenuAction
                        icon={FolderPlus}
                        label="Add Project"
                        onPress={() => {
                            closeMenu();
                            onAddProject();
                        }}
                        testID="add-project-action"
                        theme={theme}
                    />
                ) : null}
                <MenuAction
                    icon={Archive}
                    label="Archived Sessions"
                    onPress={() => {
                        closeMenu();
                        onOpenArchived();
                    }}
                    testID="archived-sessions-action"
                    theme={theme}
                />
                <MenuAction
                    icon={Settings}
                    label="Settings"
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
                    label="Forget This Computer"
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
