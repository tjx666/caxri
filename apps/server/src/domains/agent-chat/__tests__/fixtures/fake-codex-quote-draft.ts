/**
 * The fake Codex `quotedraft` reply: a lead-in and a quoted draft for the user to send on, the shape an Agent drafts a
 * message in, so a Client's quote Copy can be checked.
 */
import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * What Copy on the `quotedraft` reply's quote must put on the clipboard: its words without the `>` markers, line breaks
 * kept.
 */
export const FAKE_CODEX_QUOTE_DRAFT = [
    'Thanks for the review: the change only affects the settings page.',
    'The other pages keep their current layout.',
    '',
    'If you would rather keep the old order, I can revert that part. OK?',
].join('\n');

export async function runQuoteDraft(io: FakeCodexIo, turn: FakeTurn) {
    const quote = FAKE_CODEX_QUOTE_DRAFT.split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    await io.streamMessage(turn, `You could reply with:\n\n${quote}\n\nDone.`, 5);
}
