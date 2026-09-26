import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { EllipsisVertical, FolderPlus, Unlink } from 'lucide-react-native';

import { IconButton } from '../../../components/icon-button';
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
    menu: {
        borderRadius: 12,
        borderWidth: 1,
        boxShadow: '0px 6px 16px rgba(0, 0, 0, 0.4)',
        minWidth: 220,
        paddingVertical: 4,
        position: 'absolute',
        right: 12,
        top: 54,
        zIndex: 2,
    },
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
    label,
    onPress,
    testID,
    theme,
    tone = 'default',
}: {
    icon: typeof Unlink;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    tone?: 'danger' | 'default';
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
        <Icon color={tone === 'danger' ? theme.danger : theme.muted} size={18} />
        <Text style={[styles.menuText, { color: tone === 'danger' ? theme.danger : theme.text }]}>
            {label}
        </Text>
    </Pressable>
);

export const SessionHomeHeader = ({
    activeProjectId,
    forgetDevice,
    hostDisplayName,
    onAddProject,
    onChooseProject,
    projects,
    status,
    theme,
}: {
    activeProjectId: string | null;
    forgetDevice: () => void;
    hostDisplayName: string;
    /**
     * Present only for a control device; view and reply devices cannot widen their own Project grant.
     */
    onAddProject?: () => void;
    onChooseProject: (projectId: string | null) => void;
    projects: Project[];
    status: MobileConnectionStatus;
    theme: MobileTheme;
}) => {
    const [isMenuOpen, setMenuOpen] = useState(false);
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
                <IconButton
                    accessibilityHint="Opens computer actions."
                    accessibilityLabel="Computer menu"
                    expanded={isMenuOpen}
                    icon={EllipsisVertical}
                    onPress={() => setMenuOpen((current) => !current)}
                    testID="forget-device-button"
                    theme={theme}
                />
            </View>
            {isMenuOpen ? (
                <View
                    style={[
                        styles.menu,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                    ]}
                >
                    {onAddProject ? (
                        <MenuAction
                            icon={FolderPlus}
                            label="Add Project"
                            onPress={() => {
                                setMenuOpen(false);
                                onAddProject();
                            }}
                            testID="add-project-action"
                            theme={theme}
                        />
                    ) : null}
                    <MenuAction
                        icon={Unlink}
                        label="Forget this computer"
                        onPress={forgetDevice}
                        testID="forget-this-computer-action"
                        theme={theme}
                        tone="danger"
                    />
                </View>
            ) : null}
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
