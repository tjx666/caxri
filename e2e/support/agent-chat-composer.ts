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

/**
 * The rows Caxri itself puts at the top of a Chat's `/` menu, ahead of the provider's commands: `/new-session`, then
 * the app commands (`agentChatAppCommandActions`) a Chat with a conversation offers.
 */
export const BUILT_IN_COMMAND_ROWS = [
    /^\/new-session/u,
    /^\/status/u,
    /^\/usage/u,
    /^\/model/u,
    /^\/plan/u,
    /^\/btw/u,
    /^\/fork/u,
    /^\/new(?!-)/u,
    /^\/rename/u,
    /^\/archive/u,
    /^\/pin/u,
];

/**
 * Presses `key` `times` times, to walk the `/` menu past its built-in rows.
 */
export async function pressTimes(target: Locator, key: string, times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- each press moves the selection one row
        await target.press(key);
    }
}
