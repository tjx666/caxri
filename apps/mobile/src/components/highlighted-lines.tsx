/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import './prism-grammars';

import { memo, useCallback } from 'react';
import type { ListRenderItemInfo, StyleProp, TextStyle } from 'react-native';
import { FlatList, ScrollView, StyleSheet, Text } from 'react-native';

import type { Token, TokenOutputProps } from 'prism-react-renderer';
import { Highlight, themes } from 'prism-react-renderer';

import { MONOSPACE_FONT } from '../theme/monospace';
import { mobileSpace, mobileType } from '../theme/scale';

/**
 * One rendered row's height; fixed so the list can jump to any line without measuring the rows above it.
 */
const LINE_HEIGHT = 18;

/**
 * The width a monospace glyph takes at the preview's font size, relative to that size. Every row is as wide as the
 * longest line, so the sideways scroll reaches the end of a line whose row is not mounted yet.
 */
const MONOSPACE_ADVANCE = 0.62;

interface Line {
    index: number;
    tokens: Token[];
}

const LineList = ({
    color,
    getTokenProps,
    lines,
    testID,
    width,
}: {
    color: string;
    getTokenProps: (input: { token: Token }) => TokenOutputProps;
    lines: Line[];
    testID?: string;
    width: number;
}) => {
    const renderLine = useCallback(
        ({ item }: ListRenderItemInfo<Line>) => (
            <Text selectable style={[styles.line, { color }]}>
                {item.tokens.map((token, tokenIndex) => (
                    <Text
                        // A line's tokens never reorder, so their position is a stable key.
                        key={tokenIndex}
                        style={getTokenProps({ token }).style as StyleProp<TextStyle>}
                    >
                        {token.content}
                    </Text>
                ))}
            </Text>
        ),
        [color, getTokenProps],
    );
    return (
        <ScrollView horizontal testID={testID}>
            <FlatList
                contentContainerStyle={styles.content}
                data={lines}
                getItemLayout={(_, index) => ({
                    index,
                    length: LINE_HEIGHT,
                    offset: LINE_HEIGHT * index + mobileSpace.lg,
                })}
                initialNumToRender={60}
                keyExtractor={(line) => String(line.index)}
                maxToRenderPerBatch={60}
                renderItem={renderLine}
                style={{ width }}
                windowSize={7}
            />
        </ScrollView>
    );
};

/**
 * A whole file's syntax-colored text, one virtualized row per line. A single `Text` holding every token span of a large
 * file made Android lay out tens of thousands of spans at once: the app stopped answering and was killed. Only the rows
 * near the viewport are mounted now, so selection spans one line at a time.
 */
export const HighlightedLines = memo(
    ({
        code,
        color,
        language,
        testID,
    }: {
        code: string;
        color: string;
        language: string | null;
        testID?: string;
    }) => {
        const longest = code.split('\n').reduce((width, line) => Math.max(width, line.length), 0);
        const width = longest * styles.line.fontSize * MONOSPACE_ADVANCE + mobileSpace.lg * 2;
        return (
            <Highlight code={code} language={language ?? 'text'} theme={themes.dracula}>
                {({ getTokenProps, tokens }) => (
                    <LineList
                        color={color}
                        getTokenProps={getTokenProps}
                        lines={tokens.map((line, index) => ({ index, tokens: line }))}
                        testID={testID}
                        width={width}
                    />
                )}
            </Highlight>
        );
    },
);

const styles = StyleSheet.create({
    content: { paddingVertical: mobileSpace.lg },
    line: {
        ...mobileType.caption,
        fontFamily: MONOSPACE_FONT,
        height: LINE_HEIGHT,
        lineHeight: LINE_HEIGHT,
        paddingHorizontal: mobileSpace.lg,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
