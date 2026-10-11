import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';
import {
    extensionCommandResult,
    MAX_EXTENSION_COMMAND_MESSAGE_LENGTH,
} from '../extension-command-result.js';

describe('extensionCommandResult', () => {
    it('keeps a trimmed, capped message and ignores everything else', () => {
        expect(extensionCommandResult({ message: ' Merged #1 ' })).toEqual({
            executed: true,
            message: 'Merged #1',
        });
        expect(extensionCommandResult({ message: 'x'.repeat(400) }).message).toHaveLength(
            MAX_EXTENSION_COMMAND_MESSAGE_LENGTH,
        );
        for (const value of [undefined, null, 'Merged', { message: 1 }, { message: ' ' }])
            expect(extensionCommandResult(value)).toEqual({ executed: true });
    });

    it('produces what the IPC result schema accepts', () => {
        const schema = methods['viewContainers.executeCommand'].result;
        expect(schema.parse(extensionCommandResult({ message: 'Merged #1' }))).toEqual({
            executed: true,
            message: 'Merged #1',
        });
        expect(() => schema.parse({ executed: true, message: '' })).toThrow();
    });
});
