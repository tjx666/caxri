import type { TextStyle } from 'react-native';

import type { AgentChatComposerSpan } from './agent-chat-composer-spans';

/**
 * One styled run of the draft as the Android module `CaxriComposerSpans` applies it to the field's own text. Colors are
 * Android ARGB values; the font size is in sp, like the field's own text.
 */
export interface AgentChatComposerNativeRun {
    backgroundColor?: number;
    bold: boolean;
    color?: number;
    fontSize?: number;
    from: number;
    italic: boolean;
    monospace: boolean;
    strike: boolean;
    to: number;
}

/**
 * The draft's runs that change the field's plain look, from the same looks iOS draws as `<Text>` children. A run that
 * keeps the plain look is left out, so a draft with no Markdown sends nothing to style.
 */
export function agentChatComposerNativeRuns(
    spans: readonly AgentChatComposerSpan[],
    styleOf: (span: AgentChatComposerSpan) => TextStyle,
    color: (value: string) => number | undefined,
): AgentChatComposerNativeRun[] {
    return spans.flatMap((span) => {
        const style = styleOf(span);
        const run: AgentChatComposerNativeRun = {
            backgroundColor:
                typeof style.backgroundColor === 'string'
                    ? color(style.backgroundColor)
                    : undefined,
            bold: style.fontWeight === 'bold' || Number(style.fontWeight) >= 600,
            color: typeof style.color === 'string' ? color(style.color) : undefined,
            fontSize: style.fontSize,
            from: span.from,
            italic: style.fontStyle === 'italic',
            monospace: style.fontFamily !== undefined,
            strike: style.textDecorationLine?.includes('line-through') ?? false,
            to: span.from + span.text.length,
        };
        const isPlain =
            run.backgroundColor === undefined &&
            run.color === undefined &&
            run.fontSize === undefined &&
            !run.bold &&
            !run.italic &&
            !run.monospace &&
            !run.strike;
        return isPlain ? [] : [run];
    });
}
