import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { AgentChatService } from '../agent-chat/service';

const directories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const pending = directories.slice();
    directories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

describe('domain services close', () => {
    it('still runs the Terminal orderly snapshot and later closers after an early closer fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-domain-close-'));
        directories.push(directory);
        vi.spyOn(AgentChatService.prototype, 'shutdown').mockRejectedValue(
            new Error('agent chat shutdown failed'),
        );
        const terminalShutdown = vi.spyOn(LocalTerminalExecution.prototype, 'shutdown');
        const domains = await createTestDomainServices({
            agentEnvironment: { homeDirectory: join(directory, 'home'), variables: {} },
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
        });

        await expect(domains.close()).rejects.toThrow('agent chat shutdown failed');

        expect(terminalShutdown).toHaveBeenCalledOnce();
    });
});
