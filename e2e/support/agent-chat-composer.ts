import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * What the Chat composer's editor exposes on its editable element (`agent-chat-composer-editor.tsx`). The editor's DOM
 * text leaves out the Markdown syntax its live preview hides, so the draft is read from here instead.
 */
interface ComposerElement {
    composerSelection: { end: number; start: number };
    value: string;
}

/**
 * The composer's draft, exactly as it will be sent.
 */
export function composerValue(composer: Locator): Promise<string> {
    return composer.evaluate((element) => (element as unknown as ComposerElement).value);
}

/**
 * The composer's selection as textarea offsets into its draft.
 */
export function composerSelection(composer: Locator): Promise<{ end: number; start: number }> {
    return composer.evaluate(
        (element) => (element as unknown as ComposerElement).composerSelection,
    );
}

/**
 * Waits for the composer's draft to equal (or match) `expected`, as `toHaveValue` does for a textarea.
 */
export async function expectComposerValue(
    composer: Locator,
    expected: RegExp | string,
    options?: { timeout?: number },
): Promise<void> {
    const poll = expect.poll(() => composerValue(composer), options);
    await (typeof expected === 'string' ? poll.toBe(expected) : poll.toMatch(expected));
}
