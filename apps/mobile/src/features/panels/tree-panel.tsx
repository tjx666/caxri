import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

import { ScreenState } from '../../components/screen-state';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { panelsStyles as styles } from './panels-styles';
import { PendingPanelState } from './pending-panel-state';
import { treeChildrenView } from './tree-children-view';
import { TreeItemActionButton } from './tree-item-action-button';
import { TreeItemIcon } from './tree-item-icon';
import { useExtensionTreeSubscription, useTreeChildren } from './use-panels';

type TreeItem = MethodResult<'mobile.tree.children'>['items'][number];
type DeviceRole = 'view' | 'reply' | 'control' | null;

/**
 * Nested rows indent by this much per level; deep trees still fit a phone for a handful of levels.
 */
const INDENT = 16;

const TreeChildren = ({
    depth,
    deviceRole,
    parentHandle,
    sessionId,
    theme,
    viewId,
}: {
    depth: number;
    deviceRole: DeviceRole;
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
        return <PendingPanelState fetchStatus={children.fetchStatus} theme={theme} />;
    if (view === 'nested-loading')
        return (
            <View
                style={[styles.row, { paddingLeft: mobileSpace.sm + depth * INDENT }]}
                testID="tree-loading"
            >
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
            <ScreenState
                actionLabel={t('common.retry')}
                kind="error"
                onAction={() => {
                    void children.refetch();
                }}
                testID="tree-panel-error"
                theme={theme}
                title={t('panels.loadFailed')}
            />
        );
    if (view === 'root-empty')
        return (
            <ScreenState
                kind="empty"
                testID="tree-panel-empty"
                theme={theme}
                title={t('panels.treeEmpty')}
            />
        );
    if (view === 'nested-empty')
        return (
            <View
                accessibilityLabel={t('panels.treeChildrenEmpty')}
                accessible
                style={[styles.row, { paddingLeft: mobileSpace.sm + depth * INDENT }]}
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
                    deviceRole={deviceRole}
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
    deviceRole,
    item,
    sessionId,
    theme,
    viewId,
}: {
    depth: number;
    deviceRole: DeviceRole;
    item: TreeItem;
    sessionId: string;
    theme: MobileTheme;
    viewId: string;
}) => {
    const [isExpanded, setExpanded] = useState(item.collapsibleState === 'expanded');
    const isCollapsible = item.collapsibleState !== 'none';
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    // Inline actions change state (a merge cannot be undone), so only a control device gets them, like the merge sheet.
    const actions = deviceRole === 'control' ? (item.actions ?? []) : [];
    return (
        <View>
            <View style={styles.treeRowLine}>
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
                            paddingLeft: mobileSpace.sm + depth * INDENT,
                        },
                        styles.treeRowLabel,
                        actions.length > 0 && styles.treeRowLabelWithActions,
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
                        <Text
                            numberOfLines={1}
                            style={[styles.rowDescription, { color: theme.muted }]}
                        >
                            {item.description}
                        </Text>
                    ) : null}
                </Pressable>
                {actions.length > 0 ? (
                    <View style={styles.treeActions}>
                        {actions.map((action, index) => (
                            <TreeItemActionButton
                                key={index}
                                action={action}
                                sessionId={sessionId}
                                testID={`tree-row-action-${index}`}
                                theme={theme}
                            />
                        ))}
                    </View>
                ) : null}
            </View>
            {isCollapsible && isExpanded ? (
                <TreeChildren
                    depth={depth + 1}
                    deviceRole={deviceRole}
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
 * An extension tree view on the phone. A row's own command never runs (a tap expands it); its inline actions, such as
 * the Status panel's per-repository `Merge`, do on a control device.
 */
export const TreePanel = ({
    deviceRole,
    sessionId,
    theme,
    viewId,
}: {
    deviceRole: DeviceRole;
    sessionId: string;
    theme: MobileTheme;
    viewId: string;
}) => {
    useExtensionTreeSubscription(sessionId);
    return (
        <ScrollView style={styles.root} testID={`tree-panel-${viewId}`}>
            <TreeChildren
                depth={0}
                deviceRole={deviceRole}
                sessionId={sessionId}
                theme={theme}
                viewId={viewId}
            />
        </ScrollView>
    );
};
