import { expect, it } from 'vitest';

import { createTestServer, send, validPayload } from './server.fixture';

it('rejects a provider hook that supplies the Core-owned maintenance classification', async () => {
    const { server, socketPath, onSignal, onDiagnostic } = await createTestServer();
    try {
        const token = server.register('terminal-1', 'launch-1', 'codex');
        await send(socketPath, validPayload({ token, activity: 'maintenance' }));
        expect(onSignal).not.toHaveBeenCalled();
        expect(onDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'rejected', reason: 'invalidSignal' }),
        );
    } finally {
        await server.close();
    }
});
