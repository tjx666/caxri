import { describe, expect, it } from 'vitest';

import { configureExtensions, executeExtensionCommand, extensionApiBinding } from '../api-factory';
import { installExtensionFixture, registration } from './api-factory.fixture';

installExtensionFixture();

async function runCommandReturning(value: unknown): Promise<unknown> {
    const registered = registration();
    registered.manifest.contributes.commands = [
        { command: 'publisher.fixture.command', title: 'Fixture' },
    ];
    configureExtensions([registered]);
    extensionApiBinding('fixture-token-1').api.commands.registerCommand(
        'publisher.fixture.command',
        // The public type allows only `{ message }`; a JavaScript extension can still resolve with anything.
        () => Promise.resolve(value as never),
    );
    return executeExtensionCommand({
        extensionId: 'publisher.fixture',
        generation: 1,
        commandId: 'publisher.fixture.command',
        arguments: [],
        context: { kind: 'session', sessionId: 'session-1', workbenchProjectId: 'project-1' },
    });
}

describe('Extension command results', () => {
    it("passes a command's trimmed message through", async () => {
        await expect(runCommandReturning({ message: '  Squash-merged #123 ' })).resolves.toEqual({
            executed: true,
            message: 'Squash-merged #123',
        });
    });

    it('caps a long message', async () => {
        const result = (await runCommandReturning({ message: 'x'.repeat(500) })) as {
            message: string;
        };
        expect(result.message).toHaveLength(200);
    });

    it.each([undefined, 'Merged', { message: 42 }, { message: ' '.repeat(3) }, { other: 'x' }])(
        'ignores a result that is not a message: %o',
        async (value) => {
            await expect(runCommandReturning(value)).resolves.toEqual({ executed: true });
        },
    );
});
