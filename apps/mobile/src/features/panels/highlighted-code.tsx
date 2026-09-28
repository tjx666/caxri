import { Fragment, memo } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text } from 'react-native';

import { Highlight, themes } from 'prism-react-renderer';

/**
 * Syntax-colored spans for a file's text, using Dracula to match Desktop's default editor theme. The spans are bare
 * `Text` children so both a selectable preview and an editable `TextInput` can host them.
 */
export const HighlightedCode = memo(
    ({ code, language }: { code: string; language: string | null }) => (
        <Highlight code={code} language={language ?? 'text'} theme={themes.dracula}>
            {({ getTokenProps, tokens }) =>
                tokens.map((line, lineIndex) => (
                    <Fragment key={lineIndex}>
                        {line.map((token, tokenIndex) => {
                            const { style } = getTokenProps({ token });
                            return (
                                <Text key={tokenIndex} style={style as StyleProp<TextStyle>}>
                                    {token.content}
                                </Text>
                            );
                        })}
                        {lineIndex < tokens.length - 1 ? '\n' : null}
                    </Fragment>
                ))
            }
        </Highlight>
    ),
);
