import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { fakeClaudeChatExecutableSource } from '../agent-chat/__tests__/fixtures/fake-chat-executables';
import { createClaudeWindowService } from '../claude-window-service-creation';
import { CaxriDatabase } from '../db';

describe('createClaudeWindowService', () => {
    it('reads the signed-in account through the same Claude launch a Chat uses', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-window-creation-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const executable = join(directory, 'claude');
        await writeFile(
            executable,
            fakeClaudeChatExecutableSource({ controlDirectory: directory }),
        );
        await chmod(executable, 0o755);
        await writeFile(
            join(directory, 'claude-window.json'),
            JSON.stringify({ plan: 'pro', email: 'person@example.com', organization: 'Example' }),
        );
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(() => database.close());
        const { service } = createClaudeWindowService({
            agentRuntime: {
                agentEnvironment: {
                    homeDirectory: directory,
                    variables: { CLAUDE_CONFIG_DIR: join(directory, 'config') },
                },
                agentLaunchSettings: (provider) => defaultAgentProviderSettings[provider].launch,
            },
            database,
            dependencies: {
                terminal: { resolveExecutable: () => Promise.resolve(executable) },
            },
            logger: { write: vi.fn() } as unknown as StructuredLogger,
            send: () => {},
        });
        onTestFinished(() => service.shutdown());
        // A failed launch reads as `probeFailed`: macOS's temporary directory is a symlink the launch guard refuses.
        expect(await service.status(true)).toMatchObject({ account: { planType: 'pro' } });
    }, 30_000);
});
