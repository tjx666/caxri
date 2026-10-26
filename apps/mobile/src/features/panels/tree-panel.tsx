import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { PanelStatus, PendingPanelStatus } from './panel-status';
import { panelsStyles as styles } from './panels-styles';
import { treeChildrenView } from './tree-children-view';
import { TreeItemIcon } from './tree-item-icon';
import { useTreeChildren } from './use-panels';

type TreeItem = MethodResult<'mobile.tree.children'>['items'][number];

/**
 * Nested rows indent by this much per level; deep trees still fit a phone for a handful of levels.
 */
const INDENT = 16;

const TreeChildren = ({
    depth,
    parentHandle,
    sessionId,
    theme,
    viewId,
}: {
    depth: number;
    parentHandle?: string;
    sessionId: string;
    theme: MobileTheme;
    viewId: string;
}) => {
    const { t } = useTranslation();
    const children = useTreeChildren(sessionId, viewId, parentHandle);
    const view = treeChildrenView({
        depth,
        isError: children.isError,
        isPending: children.isPending,
        itemCount: children.data?.items.length ?? 0,
    });
    if (view === 'root-loading')
        return <PendingPanelStatus fetchStatus={children.fetchStatus} theme={theme} />;
    if (view === 'nested-loading')
        return (
            <View style={[styles.row, { paddingLeft: 8 + depth * INDENT }]} testID="tree-loading">
                <Spinner
                    accessibilityLabel={t('panels.treeLoadingChildren')}
                    color={theme.muted}
                    isDelayed
                    size={16}
                />
            </View>
        );
    if (view === 'error')
        return (
            <PanelStatus
                message={t('panels.loadFailed')}
                onRetry={() => {
                    void children.refetch();
                }}
                testID="tree-panel-error"
                theme={theme}
            />
        );
    if (view === 'root-empty')
        return (
            <PanelStatus message={t('panels.treeEmpty')} testID="tree-panel-empty" theme={theme} />
        );
    if (view === 'nested-empty')
        return (
            <View
                accessibilityLabel={t('panels.treeChildrenEmpty')}
                accessible
                style={[styles.row, { paddingLeft: 8 + depth * INDENT }]}
                testID="tree-nested-empty"
            >
                <Text style={[styles.rowText, { color: theme.muted }]}>
                    {t('panels.treeChildrenEmpty')}
                </Text>
            </View>
        );
    return (
        <>
            {(children.data?.items ?? []).map((item) => (
                // eslint-disable-next-line @typescript-eslint/no-use-before-define, no-use-before-define -- Rows and their children recurse into each other.
                <TreeRow
                    key={item.handle}
                    depth={depth}
                    item={item}
                    sessionId={sessionId}
                    theme={theme}
                    viewId={viewId}
                />
            ))}
        </>
    );
};

const TreeRow = ({
    depth,
    item,
    sessionId,
    theme,
    viewId,
}: {
    depth: number;
    item: TreeItem;
    sessionId: string;
    theme: MobileTheme;
    viewId: string;
}) => {
    const [isExpanded, setExpanded] = useState(item.collapsibleState === 'expanded');
    const isCollapsible = item.collapsibleState !== 'none';
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    return (
        <View>
            <Pressable
                accessibilityLabel={[item.label, item.description].filter(Boolean).join(', ')}
                accessibilityRole={isCollapsible ? 'button' : 'text'}
                accessibilityState={isCollapsible ? { expanded: isExpanded } : undefined}
                disabled={!isCollapsible}
                onPress={() => setExpanded((value) => !value)}
                style={({ pressed }) => [
                    styles.row,
                    {
                        backgroundColor: pressed ? theme.surface : 'transparent',
                        paddingLeft: 8 + depth * INDENT,
                    },
                ]}
                testID="tree-row"
            >
                <View style={styles.treeChevron}>
                    {isCollapsible ? <Chevron color={theme.muted} size={16} /> : null}
                </View>
                {item.icon ? <TreeItemIcon icon={item.icon} theme={theme} /> : null}
                <Text numberOfLines={1} style={[styles.rowText, { color: theme.text }]}>
                    {item.label}
                </Text>
                {item.description ? (
                    <Text numberOfLines={1} style={[styles.rowDescription, { color: theme.muted }]}>
                        {item.description}
                    </Text>
                ) : null}
            </Pressable>
            {isCollapsible && isExpanded ? (
                <TreeChildren
                    depth={depth + 1}
                    parentHandle={item.handle}
                    sessionId={sessionId}
                    theme={theme}
                    viewId={viewId}
                />
            ) : null}
        </View>
    );
};

/**
 * Read-only rendering of an extension tree view. Rows never run their commands on the phone.
 */
export const TreePanel = ({
    sessionId,
    theme,
    viewId,
}: {
    sessionId: string;
    theme: MobileTheme;
    viewId: string;
}) => (
    <ScrollView style={styles.root} testID={`tree-panel-${viewId}`}>
        <TreeChildren depth={0} sessionId={sessionId} theme={theme} viewId={viewId} />
    </ScrollView>
);
