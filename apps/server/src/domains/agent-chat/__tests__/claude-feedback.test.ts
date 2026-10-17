import { describe, expect, it } from 'vitest';

import { claudeFeedbackItems } from '../claude-feedback';
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
                kind: 'output',
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
    it('preserves repeated plugin directories, including spaces, for Chat launch', () => {
        expect(
            claudeChatSettings({
                executable: 'claude',
                args: ['--plugin-dir', 'Example Mod', '--plugin-dir=another-mod'],
            }),
        ).toMatchObject({ pluginDirectories: ['Example Mod', 'another-mod'] });
    });
});
