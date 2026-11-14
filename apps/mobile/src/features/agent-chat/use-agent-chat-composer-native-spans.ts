import type { RefObject } from 'react';
import { useEffect } from 'react';
import type { TextInputInstance } from 'react-native';
import { findNodeHandle, processColor } from 'react-native';

import { requireOptionalNativeModule } from 'expo';

import type { MobileTheme } from '../../theme/tokens';
import { agentChatComposerSpanStyle } from './agent-chat-composer-looks';
import type { AgentChatComposerNativeRun } from './agent-chat-composer-native-runs';
import { agentChatComposerNativeRuns } from './agent-chat-composer-native-runs';
import type { AgentChatComposerSpan } from './agent-chat-composer-spans';

interface CaxriComposerSpansModule {
    apply(viewTag: number, text: string, runs: AgentChatComposerNativeRun[]): Promise<boolean>;
}

/**
 * The local module in `modules/caxri-composer-spans`, Android only. React Native's Android field rewrites its whole
 * text whenever its `<Text>` children change, which breaks a Chinese IME's open composition on every key, so there the
 * composer keeps a plain `value` and this module styles the text in place. iOS compares only the plain text while a
 * composition is open, so it keeps the children.
 */
const composerSpansModule =
    requireOptionalNativeModule<CaxriComposerSpansModule>('CaxriComposerSpans');

/**
 * Whether the field styles its own text natively instead of drawing `<Text>` children.
 */
export const isNativeComposerStyling = composerSpansModule !== null;

const nativeColor = (value: string): number | undefined => {
    const color = processColor(value);
    return typeof color === 'number' ? color : undefined;
};

/**
 * Styles the field's text with the draft's runs after each render. A draft the field has already moved past is skipped
 * natively; the render for the newer text follows.
 */
export function useAgentChatComposerNativeSpans({
    draft,
    inputReference,
    spans,
    theme,
}: {
    draft: string;
    inputReference: RefObject<TextInputInstance | null>;
    spans: readonly AgentChatComposerSpan[];
    theme: MobileTheme;
}): void {
    useEffect(() => {
        if (!composerSpansModule || !inputReference.current) return;
        const viewTag = findNodeHandle(inputReference.current);
        if (viewTag === undefined) return;
        const runs = agentChatComposerNativeRuns(
            spans,
            (span) => agentChatComposerSpanStyle(span, theme),
            nativeColor,
        );
        // Styling is best effort: a failed call leaves the draft readable in the field's plain look.
        void composerSpansModule.apply(viewTag, draft, runs).catch(() => false);
    }, [draft, inputReference, spans, theme]);
}
