import { Text, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { DiffLine } from './changes-model';
import { diffLineNumber } from './changes-model';
import { changesStyles as styles } from './changes-styles';

/**
 * Width of one digit in the 12-point monospace diff font.
 */
const DIGIT_WIDTH = 7.5;

/**
 * One diff line: a single line-number gutter, the change marker, and the text, which wraps under itself instead of
 * scrolling sideways so an ordinary change reads on a phone without panning.
 */
export const ChangesDiffRow = ({
    line,
    lineNumberDigits,
    theme,
}: {
    line: DiffLine;
    /**
     * From `diffLineNumberDigits` over the rows shown together, so their gutters line up.
     */
    lineNumberDigits: number;
    theme: MobileTheme;
}) => {
    const color =
        line.kind === 'added'
            ? theme.gitAdded
            : line.kind === 'removed'
              ? theme.gitDeleted
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
            <Text
                style={[
                    styles.lineNumber,
                    { color: theme.muted, width: lineNumberDigits * DIGIT_WIDTH },
                ]}
            >
                {diffLineNumber(line) ?? ''}
            </Text>
            <Text style={[styles.marker, { color }]}>{line.marker}</Text>
            <Text style={[styles.diffText, { color }]}>{line.content || ' '}</Text>
        </View>
    );
};
