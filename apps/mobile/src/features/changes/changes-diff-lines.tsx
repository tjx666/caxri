import { useCallback, useMemo } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffRow } from './changes-diff-row';
import type { DiffLine } from './changes-model';
import { parseUnifiedDiff, visibleDiffLines } from './changes-model';
import { changesStyles as styles } from './changes-styles';

export const ChangesDiffLines = ({ patch, theme }: { patch: string; theme: MobileTheme }) => {
    const lines = useMemo(() => visibleDiffLines(parseUnifiedDiff(patch).lines), [patch]);
    const renderItem = useCallback(
        ({ item }: ListRenderItemInfo<DiffLine>) => <ChangesDiffRow line={item} theme={theme} />,
        [theme],
    );
    const keyExtractor = useCallback((line: DiffLine) => line.id, []);
    return (
        <FlatList
            contentContainerStyle={styles.diffContent}
            data={lines}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            style={styles.diffList}
            testID="changes-diff-scroll"
        />
    );
};
