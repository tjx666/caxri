import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

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
        borderBottomWidth: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        minHeight: 76,
        paddingHorizontal: 16,
    },
    heading: { flexShrink: 1, fontSize: 22, fontWeight: '700' },
    connectionDot: { borderRadius: 5, height: 9, marginRight: 8, width: 9 },
    headingRow: { alignItems: 'center', flex: 1, flexDirection: 'row', minWidth: 0 },
    menuButton: { justifyContent: 'center', minHeight: 48, minWidth: 48 },
    menuText: { fontSize: 14, fontWeight: '600' },
    menu: {
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 12,
        position: 'absolute',
        right: 12,
        top: 62,
        zIndex: 2,
    },
    menuAction: { justifyContent: 'center', minHeight: 48 },
    chips: { gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
    chipsScroll: { flexGrow: 0 },
    chip: {
        borderRadius: 16,
        borderWidth: 1,
        justifyContent: 'center',
        minHeight: 48,
        paddingHorizontal: 14,
    },
    chipText: { fontSize: 13, fontWeight: '600' },
});

export const SessionHomeHeader = ({
    activeProjectId,
    forgetDevice,
    hostDisplayName,
    onChooseProject,
    projects,
    status,
    theme,
}: {
    activeProjectId: string | null;
    forgetDevice: () => void;
    hostDisplayName: string;
    onChooseProject: (projectId: string | null) => void;
    projects: Project[];
    status: MobileConnectionStatus;
    theme: MobileTheme;
}) => {
    const [isMenuOpen, setMenuOpen] = useState(false);
    const projectChoices: ProjectChoice[] = [{ id: null, displayTitle: 'All' }, ...projects];
    const renderProject = useCallback(
        ({ item }: { item: ProjectChoice }) => (
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: activeProjectId === item.id }}
                onPress={() => onChooseProject(item.id)}
                style={[
                    styles.chip,
                    {
                        backgroundColor:
                            activeProjectId === item.id ? theme.surface : theme.background,
                        borderColor: activeProjectId === item.id ? theme.primary : theme.border,
                    },
                ]}
                testID={`project-filter-${item.id ?? 'all'}`}
            >
                <Text style={[styles.chipText, { color: theme.text }]}>{item.displayTitle}</Text>
            </Pressable>
        ),
        [activeProjectId, onChooseProject, theme],
    );
    return (
        <>
            <View style={[styles.header, { borderColor: theme.border }]}>
                <View style={styles.headingRow}>
                    <View
                        style={[
                            styles.connectionDot,
                            {
                                backgroundColor:
                                    status === 'connected' ? theme.primary : theme.muted,
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
                <Pressable
                    accessibilityHint="Opens computer actions."
                    accessibilityLabel="Computer menu"
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isMenuOpen }}
                    onPress={() => setMenuOpen((current) => !current)}
                    style={styles.menuButton}
                    testID="forget-device-button"
                >
                    <Text style={[styles.menuText, { color: theme.muted }]}>⋯</Text>
                </Pressable>
            </View>
            {isMenuOpen ? (
                <View
                    style={[
                        styles.menu,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                    ]}
                >
                    <Pressable
                        accessibilityHint="Removes this device credential and returns to pairing."
                        accessibilityRole="button"
                        onPress={forgetDevice}
                        style={styles.menuAction}
                        testID="forget-this-computer-action"
                    >
                        <Text style={[styles.menuText, { color: theme.text }]}>
                            Forget this computer
                        </Text>
                    </Pressable>
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
