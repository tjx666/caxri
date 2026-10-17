import { useCallback, useMemo, useState } from 'react';
import type { LayoutChangeEvent, ListRenderItemInfo } from 'react-native';
import { FlatList, ScrollView, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffRow } from './changes-diff-row';
import type { DiffLine } from './changes-model';
import { parseUnifiedDiff, visibleDiffLines } from './changes-model';
import { changesStyles as styles } from './changes-styles';

export const ChangesDiffLines = ({ patch, theme }: { patch: string; theme: MobileTheme }) => {
    const lines = useMemo(() => visibleDiffLines(parseUnifiedDiff(patch).lines), [patch]);
    const [viewport, setViewport] = useState({ height: 0, width: 0 });
    const onLayout = useCallback((event: LayoutChangeEvent): void => {
        const { height, width } = event.nativeEvent.layout;
        setViewport((current) =>
            current.height === height && current.width === width ? current : { height, width },
        );
    }, []);
    const contentWidth = useMemo(
        () =>
            Math.max(
                viewport.width,
                118 + Math.max(0, ...lines.map((line) => line.content.length)) * 12,
            ),
        [lines, viewport.width],
    );
    const renderItem = useCallback(
        ({ item }: ListRenderItemInfo<DiffLine>) => <ChangesDiffRow line={item} theme={theme} />,
        [theme],
    );
    const keyExtractor = useCallback((line: DiffLine) => line.id, []);
    return (
        <ScrollView
            horizontal
            onLayout={onLayout}
            style={styles.diffScroll}
            testID="changes-diff-scroll"
        >
            {viewport.height > 0 ? (
                <View style={{ height: viewport.height, width: contentWidth }}>
                    <FlatList
                        contentContainerStyle={styles.diffContent}
                        data={lines}
                        keyExtractor={keyExtractor}
                        renderItem={renderItem}
                        style={styles.diffList}
                    />
                </View>
            ) : null}
        </ScrollView>
    );
};
