import { Text } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { agentChatComposerSpanStyle } from './agent-chat-composer-looks';
import type { AgentChatComposerSpan } from './agent-chat-composer-spans';

/**
 * The draft as styled runs, the text field's children in place of its `value`. iOS only: Android styles the field's own
 * text instead (`agentChatComposerNativeRuns`).
 */
export const AgentChatComposerDraft = ({
    spans,
    theme,
}: {
    spans: AgentChatComposerSpan[];
    theme: MobileTheme;
}) =>
    spans.map((span) => (
        <Text key={span.from} style={agentChatComposerSpanStyle(span, theme)}>
            {span.text}
        </Text>
    ));
