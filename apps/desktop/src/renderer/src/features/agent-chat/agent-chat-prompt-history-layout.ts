import type { AgentChatPromptHistoryDirection } from './agent-chat-prompt-history';

/**
 * A newline check cannot see Chromium's soft wraps. Measure the caret against the rendered first or last line before
 * taking an arrow away from native navigation. Markers have no width, so the measurement adds no extra wrapped glyph.
 */
export function isAgentChatPromptHistoryBoundary(
    input: HTMLTextAreaElement,
    direction: AgentChatPromptHistoryDirection,
): boolean {
    const caret = input.selectionStart;
    if (direction === 'backward' && caret === 0) return true;
    if (direction === 'forward' && caret === input.value.length) return true;
    const document = input.ownerDocument;
    const view = document.defaultView;
    if (!view || input.clientWidth === 0) return false;
    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    mirror.style.cssText =
        'position:fixed;left:-100000px;top:0;visibility:hidden;box-sizing:border-box;';
    const computed = view.getComputedStyle(input);
    for (const property of [
        'font-family',
        'font-size',
        'font-weight',
        'font-style',
        'font-stretch',
        'font-variant',
        'font-kerning',
        'font-feature-settings',
        'font-variation-settings',
        'line-height',
        'letter-spacing',
        'word-spacing',
        'white-space',
        'overflow-wrap',
        'word-break',
        'text-indent',
        'text-align',
        'direction',
        'tab-size',
        'padding-top',
        'padding-right',
        'padding-bottom',
        'padding-left',
    ])
        mirror.style.setProperty(property, computed.getPropertyValue(property));
    mirror.style.width = `${input.clientWidth}px`;
    const marker = () => {
        const span = document.createElement('span');
        span.textContent = '\u{200B}';
        return span;
    };
    const first = marker();
    const current = marker();
    const last = marker();
    mirror.append(first, input.value.slice(0, caret), current, input.value.slice(caret), last);
    document.body.append(mirror);
    try {
        const boundary = direction === 'backward' ? first : last;
        return (
            Math.abs(current.getBoundingClientRect().top - boundary.getBoundingClientRect().top) < 1
        );
    } finally {
        mirror.remove();
    }
}
