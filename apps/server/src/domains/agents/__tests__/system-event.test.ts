import { describe, expect, it } from 'vitest';

import { classifySystemEvent } from '../system-event';

describe('classifySystemEvent', () => {
    it('classifies a task notification with its full body as detail', () => {
        const result = classifySystemEvent(
            '<task-notification><task-id>task-1</task-id><tool-use-id>tool-1</tool-use-id>' +
                '<output-file>/tmp/fixture/task-1.output</output-file><status>failed</status>' +
                '<summary>Background command "bun test" failed with exit code 1</summary></task-notification>',
        );
        expect(result).toEqual({
            kind: 'taskNotification',
            status: 'failed',
            summary: 'Background command "bun test" failed with exit code 1',
        });
        expect(JSON.stringify(result)).not.toContain('/tmp/fixture');
        expect(JSON.stringify(result)).not.toContain('task-1');
    });

    it('keeps a background Agent result as detail and maps unknown outcomes', () => {
        expect(
            classifySystemEvent(
                '<task-notification><status>completed</status><summary>Agent "Review" finished</summary>' +
                    '<result>No blocking findings.</result></task-notification>',
            ),
        ).toEqual({
            kind: 'taskNotification',
            status: 'completed',
            summary: 'Agent "Review" finished',
            detail: 'No blocking findings.',
        });
        expect(
            classifySystemEvent(
                '<task-notification><status>paused</status><summary>Task paused</summary></task-notification>',
            ),
        ).toMatchObject({ status: 'unknown' });
    });

    it('classifies a slash command echo, folding stdout and caveat into detail', () => {
        const result = classifySystemEvent(
            '<command-message>Clears the conversation</command-message>' +
                '<command-name>/clear</command-name>' +
                '<command-args></command-args>' +
                '<local-command-stdout>Conversation cleared.</local-command-stdout>' +
                '<local-command-caveat>Local command output is not sent to the model.</local-command-caveat>',
        );
        expect(result).toEqual({
            kind: 'slashCommand',
            summary: '/clear',
            detail: 'Conversation cleared.\n\nLocal command output is not sent to the model.',
        });
    });

    it('keeps why a slash command failed from its stderr', () => {
        expect(
            classifySystemEvent(
                '<command-name>/compact</command-name>' +
                    '<local-command-stderr>Error: No messages to compact</local-command-stderr>',
            ),
        ).toEqual({
            kind: 'slashCommand',
            summary: '/compact',
            detail: 'Error: No messages to compact',
        });
    });

    it('falls back to the command message when the command has no name', () => {
        const result = classifySystemEvent('<command-message>Ran a saved prompt</command-message>');
        expect(result).toMatchObject({ kind: 'slashCommand', summary: 'Ran a saved prompt' });
    });

    it('classifies a bash-mode echo, combining stdout and stderr into detail', () => {
        const result = classifySystemEvent(
            '<bash-input>ls -la /tmp</bash-input>' +
                '<bash-stdout>total 0</bash-stdout>' +
                '<bash-stderr>permission denied</bash-stderr>',
        );
        expect(result).toEqual({
            kind: 'bashCommand',
            summary: 'ls -la /tmp',
            detail: 'total 0\n\npermission denied',
        });
    });

    it('classifies a standalone caveat with no attached command as its own kind', () => {
        const result = classifySystemEvent(
            '<local-command-caveat>Local command output is not sent to the model.</local-command-caveat>',
        );
        expect(result).toEqual({
            kind: 'caveat',
            summary: 'Local command output is not sent to the model.',
        });
    });

    it('does not classify a system reminder or plain user text', () => {
        expect(
            classifySystemEvent('<system-reminder>Internal harness note</system-reminder>'),
        ).toBeUndefined();
        expect(classifySystemEvent('Please check the failing test')).toBeUndefined();
    });

    it('prefers the command classification when a caveat is attached to a slash command', () => {
        const result = classifySystemEvent(
            '<command-name>/clear</command-name><local-command-caveat>Note</local-command-caveat>',
        );
        expect(result?.kind).toBe('slashCommand');
    });
});
