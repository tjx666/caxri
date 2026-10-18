import { describe, expect, it } from 'vitest';

import { claudeFeedbackItems, claudeFeedbackToolUseId } from '../claude-feedback';
import { claudeChatSettings } from '../launch-settings';

describe('real Claude feedback envelopes', () => {
    it('keeps live mod output separate from model replies', () => {
        expect(
            claudeFeedbackItems(
                {
                    type: 'assistant',
                    uuid: 'command',
                    local_command_run: { command: 'display-test', args: '', plugin: 'example-mod' },
                    local_command_source:
                        '<local-command-stdout>Example mod output.\nRead these details.</local-command-stdout>',
                },
                'turn',
            ),
        ).toEqual([
            expect.objectContaining({
                type: 'notice',
                kind: 'warning',
                turnId: 'turn',
                title: 'example-mod · /display-test',
                message: 'Example mod output.\nRead these details.',
            }),
        ]);
    });
    it('uses the intact structured mod reason and warning severity', () => {
        expect(
            claudeFeedbackItems({
                subtype: 'informational',
                content: 'Damaged provider display text.',
                level: 'warning',
                prompt_submit_outcome: {
                    kind: 'dropped_by_hook',
                    reason: 'Input blocked.\nChoose another input.',
                },
            }),
        ).toEqual([
            expect.objectContaining({
                kind: 'warning',
                message: 'Input blocked.\nChoose another input.',
            }),
        ]);
    });
    it('normalizes live and persisted tool ownership without guessing from Hook lifecycle events', () => {
        expect(
            claudeFeedbackToolUseId({ subtype: 'informational', tool_use_id: 'toolu_live' }),
        ).toBe('toolu_live');
        expect(
            claudeFeedbackToolUseId({
                type: 'attachment',
                attachment: { type: 'hook_non_blocking_error', toolUseID: 'toolu_saved' },
            }),
        ).toBe('toolu_saved');
        expect(claudeFeedbackToolUseId({ subtype: 'hook_response', hook_id: 'hook-only' })).toBe(
            undefined,
        );
    });
    it('uses the SDK continuation flag when no structured outcome is present', () => {
        expect(
            claudeFeedbackItems({
                subtype: 'informational',
                tool_use_id: 'toolu_read',
                prevent_continuation: true,
                level: 'notice',
                content: 'Retry with a smaller range.',
            }),
        ).toEqual([
            expect.objectContaining({
                kind: 'warning',
                title: 'Input blocked by Hook',
                message: 'Retry with a smaller range.',
            }),
        ]);
    });
    it('preserves repeated plugin directories, including spaces, for Chat launch', () => {
        expect(
            claudeChatSettings({
                executable: 'claude',
                args: ['--plugin-dir', 'Example Mod', '--plugin-dir=another-mod'],
            }),
        ).toMatchObject({ pluginDirectories: ['Example Mod', 'another-mod'] });
    });
});
