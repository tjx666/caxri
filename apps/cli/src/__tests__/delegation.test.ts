import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { CliServerClient } from '../application';
import { runCli } from '../application';

it('lets a granted managed Agent delegate non-interactively while retaining owner confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-cli-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'task.md');
    await writeFile(path, 'Synthetic task');
    const requestWithId = vi.fn().mockResolvedValue({ delegationId: 'task', status: 'requested' });
    const client: CliServerClient = {
        close: vi.fn(),
        request: vi.fn(),
        requestWithId,
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: {
                kind: 'agent',
                id: 'agent:endpoint-1',
                endpointId: 'endpoint-1',
                generation: 2,
                projectIds: ['project-1'],
            },
            capabilities: ['agents.delegate'],
            commands: ['agent.delegation.create'],
        },
    };
    const connect = vi.fn().mockResolvedValue(client);
    const io = {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stderrIsTTY: false,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
    };
    const arguments_ = [
        'agent',
        'delegate',
        'create',
        '--project',
        'project-1',
        '--session',
        'session-1',
        '--provider',
        'claude',
        '--prompt-file',
        path,
        '--request-id',
        'request-1',
        '--json',
    ];
    expect(
        await runCli(arguments_, {
            connect,
            io,
            environment: {
                CODEX_THREAD_ID: 'thread-1',
                CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
                CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
                CAXRI_AGENT_ENDPOINT_GENERATION: '2',
                CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
                CAXRI_USER_DATA_DIR: '/profiles/agent',
            },
        }),
    ).toBe(0);
    expect(requestWithId).toHaveBeenCalledWith('request-1', 'agent.delegation.create', {
        projectId: 'project-1',
        sessionId: 'session-1',
        provider: 'claude',
        prompt: 'Synthetic task',
    });
    connect.mockClear();
    expect(
        await runCli([...arguments_, '--profile', '/profiles/owner'], {
            connect,
            io,
            environment: {},
        }),
    ).not.toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(io.writeStderr.mock.calls.flat().join('')).toContain('--yes');
});
