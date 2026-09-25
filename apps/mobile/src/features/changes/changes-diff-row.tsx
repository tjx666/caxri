import { Text, View } from 'react-native';

import { draculaTheme } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import type { DiffLine } from './changes-model';
import { changesStyles as styles } from './changes-styles';

export const ChangesDiffRow = ({ line, theme }: { line: DiffLine; theme: MobileTheme }) => {
    const color =
        line.kind === 'added'
            ? draculaTheme.colors.success
            : line.kind === 'removed'
              ? theme.danger
              : line.kind === 'hunk'
                ? theme.primary
                : line.kind === 'context'
                  ? theme.text
                  : theme.muted;
    return (
        <View
            accessibilityLabel={`${line.oldLine ?? ''} ${line.newLine ?? ''} ${line.marker} ${line.content}`}
            style={styles.diffRow}
        >
            <Text style={[styles.lineNumber, { color: theme.muted }]}>{line.oldLine ?? ''}</Text>
            <Text style={[styles.lineNumber, { color: theme.muted }]}>{line.newLine ?? ''}</Text>
            <Text style={[styles.marker, { color }]}>{line.marker}</Text>
            <Text numberOfLines={1} style={[styles.diffText, { color }]}>
                {line.content || ' '}
            </Text>
        </View>
    );
};
