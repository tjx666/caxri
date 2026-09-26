import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-client';
import { PanelStatus, PendingPanelStatus } from './panel-status';
import { panelsStyles as styles } from './panels-styles';
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
    const children = useTreeChildren(sessionId, viewId, parentHandle);
    if (children.isPending)
        return depth === 0 ? (
            <PendingPanelStatus fetchStatus={children.fetchStatus} theme={theme} />
        ) : null;
    if (children.isError) {
        /**
         * Extension trees follow the Session active on Desktop, and the phone never changes that selection, so a
         * different Session is reported as a state to act on rather than as a failure.
         */
        const isOtherSession =
            children.error instanceof MobileGatewayRequestError &&
            children.error.code === 'CONFLICT';
        return (
            <PanelStatus
                message={
                    isOtherSession
                        ? 'Open this Session on your computer to view its details here.'
                        : 'Unable to load this view.'
                }
                onRetry={() => {
                    // eslint-disable-next-line no-void -- The query renders its own error state.
                    void children.refetch();
                }}
                testID={isOtherSession ? 'tree-panel-other-session' : 'tree-panel-error'}
                theme={theme}
            />
        );
    }
    if (depth === 0 && children.data.items.length === 0)
        return <PanelStatus message="Nothing to show." testID="tree-panel-empty" theme={theme} />;
    return (
        <>
            {children.data.items.map((item) => (
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
