import type { ReactNode } from 'react';
import { memo, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import type { LucideProps } from 'lucide-react-native';
import { FolderTree, GitBranch, ListTree } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { FilesPanel } from './files-panel';
import { PanelStatus } from './panel-status';
import { panelsStyles as styles } from './panels-styles';
import { TreePanel } from './tree-panel';
import { usePanelsList } from './use-panels';

type Panel = MethodResult<'mobile.panels.list'>['panels'][number];
type PanelView = Panel['views'][number];

const PanelIcon = ({ panel, ...iconProperties }: LucideProps & { panel: Panel }) => {
    const kind = panel.views[0]?.kind;
    if (kind === 'files') return <FolderTree {...iconProperties} />;
    if (kind === 'changes') return <GitBranch {...iconProperties} />;
    return <ListTree {...iconProperties} />;
};

const PanelBody = ({
    changesPanel,
    sessionId,
    theme,
    view,
}: {
    changesPanel: ReactNode;
    sessionId: string;
    theme: MobileTheme;
    view: PanelView;
}) => {
    switch (view.kind) {
        case 'files':
            return <FilesPanel sessionId={sessionId} theme={theme} />;
        case 'changes':
            return changesPanel;
        case 'tree':
            return <TreePanel key={view.id} sessionId={sessionId} theme={theme} viewId={view.id} />;
        default:
            return (
                <PanelStatus
                    message={`${view.title} is only available on your computer.`}
                    theme={theme}
                />
            );
    }
};

const PanelTab = memo(
    ({
        isSelected,
        onSelect,
        panel,
        theme,
    }: {
        isSelected: boolean;
        onSelect: (id: string) => void;
        panel: Panel;
        theme: MobileTheme;
    }) => {
        const color = isSelected ? theme.primaryForeground : theme.text;
        return (
            <Pressable
                accessibilityLabel={panel.title}
                accessibilityRole="tab"
                accessibilityState={{ selected: isSelected }}
                onPress={() => onSelect(panel.id)}
                style={[
                    styles.tab,
                    { backgroundColor: isSelected ? theme.primary : theme.surface },
                ]}
                testID={`panel-tab-${panel.id}`}
            >
                <PanelIcon color={color} panel={panel} size={16} />
                <Text style={[styles.tabText, { color }]}>{panel.title}</Text>
            </Pressable>
        );
    },
);

/**
 * Mirrors Desktop's right sidebar (Files, Git, Status, and any extension panel) for one Session, read-only. The Git
 * panel reuses the Changes view because Desktop's source-control view is the same data behind a richer editor.
 */
export const PanelsView = ({
    changesPanel,
    sessionId,
    theme,
}: {
    changesPanel: ReactNode;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const panels = usePanelsList(sessionId);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    if (panels.isPending) return <PanelStatus isLoading theme={theme} />;
    if (panels.isError)
        return (
            <PanelStatus
                message="Unable to load panels."
                onRetry={() => {
                    // eslint-disable-next-line no-void -- The query renders its own error state.
                    void panels.refetch();
                }}
                testID="panels-error"
                theme={theme}
            />
        );
    const available = panels.data.panels.filter((panel) => panel.views.length > 0);
    const selected = available.find((panel) => panel.id === selectedId) ?? available.at(0);
    if (!selected) return <PanelStatus message="No panels are available." theme={theme} />;
    const renderTab = ({ item }: ListRenderItemInfo<Panel>) => (
        <PanelTab
            isSelected={item.id === selected.id}
            onSelect={setSelectedId}
            panel={item}
            theme={theme}
        />
    );
    return (
        <View style={styles.root} testID="panels-view">
            <FlatList
                horizontal
                contentContainerStyle={styles.tabs}
                data={available}
                extraData={selected.id}
                keyExtractor={(panel) => panel.id}
                renderItem={renderTab}
                showsHorizontalScrollIndicator={false}
                style={styles.tabList}
            />
            <View style={styles.body}>
                {selected.views.length === 1 ? (
                    <PanelBody
                        changesPanel={changesPanel}
                        sessionId={sessionId}
                        theme={theme}
                        view={selected.views[0]}
                    />
                ) : (
                    selected.views.map((view) => (
                        <View key={view.id} style={styles.body}>
                            <Text style={[styles.viewTitle, { color: theme.muted }]}>
                                {view.title}
                            </Text>
                            <PanelBody
                                changesPanel={changesPanel}
                                sessionId={sessionId}
                                theme={theme}
                                view={view}
                            />
                        </View>
                    ))
                )}
            </View>
        </View>
    );
};
