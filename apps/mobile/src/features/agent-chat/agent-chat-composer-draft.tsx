import type { TextStyle } from 'react-native';
import { Text } from 'react-native';

import { MONOSPACE_FONT } from '../../theme/monospace';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatComposerSpan } from './agent-chat-composer-spans';

type Inline = AgentChatComposerSpan['inline'][number];
type Line = NonNullable<AgentChatComposerSpan['line']>;

/**
 * Desktop's composer looks (`agent-chat-composer-extensions.ts`) in React Native terms. Headings grow less than
 * Desktop's so a heading line keeps the field's 21dp line box; a quote is muted because a span cannot draw the bar.
 */
const lineStyles = (theme: MobileTheme): Record<Line, TextStyle> => ({
    code: { fontFamily: MONOSPACE_FONT, fontSize: 13 },
    fence: { color: theme.muted, fontFamily: MONOSPACE_FONT, fontSize: 13 },
    heading1: { fontSize: 18, fontWeight: '700' },
    heading2: { fontSize: 17, fontWeight: '700' },
    heading3: { fontSize: 16, fontWeight: '600' },
    list: {},
    quote: { color: theme.muted },
});

const inlineStyles = (theme: MobileTheme): Record<Inline, TextStyle> => ({
    code: { backgroundColor: theme.elevated, fontFamily: MONOSPACE_FONT, fontSize: 13 },
    emphasis: { fontStyle: 'italic' },
    strike: { textDecorationLine: 'line-through' },
    strong: { fontWeight: '600' },
    syntax: { color: theme.muted },
});

/**
 * Syntax hidden away from the cursor. A native field cannot drop characters it holds, so they shrink to a sliver and
 * turn transparent; the cursor reaching them reveals them again (`agentChatComposerSpans`).
 */
const HIDDEN: TextStyle = { color: 'transparent', fontSize: 1 };

/**
 * The draft as styled runs, the text field's children in place of its `value`.
 */
export const AgentChatComposerDraft = ({
    spans,
    theme,
}: {
    spans: AgentChatComposerSpan[];
    theme: MobileTheme;
}) => {
    const lines = lineStyles(theme);
    const inline = inlineStyles(theme);
    const image: TextStyle = { backgroundColor: theme.elevated, color: theme.primary };
    return spans.map((span) => (
        <Text
            key={span.from}
            style={[
                span.line ? lines[span.line] : undefined,
                ...span.inline.map((style) => inline[style]),
                span.isImage ? image : undefined,
                span.isHidden ? HIDDEN : undefined,
            ]}
        >
            {span.text}
        </Text>
    ));
};
