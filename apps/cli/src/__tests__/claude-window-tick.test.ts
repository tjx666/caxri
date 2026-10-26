import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliIo, CliServerClient } from '../application';
import { runCli } from '../application';

function io() {
    let stderr = '';
    const value: CliIo = {
        stderrIsTTY: false,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        writeStderr: (text) => {
            stderr += text;
        },
        writeStdout: () => {},
    };
    return { io: value, stderr: () => stderr };
}

function server(): CliServerClient {
    return {
        close: vi.fn(),
        request: vi.fn(() =>
            Promise.resolve({ status: 'off', background: 'registered', wakeTimes: [] }),
        ),
        requestWithId: vi.fn(),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'cli-test' },
            capabilities: ['settings.write'],
            commands: ['claudeWindow.tick'],
        } satisfies ProtocolWelcome,
    };
}

describe('host claude-window-tick', () => {
    it('runs one check for the selected profile without an interactive confirmation, as the background job does', async () => {
        const client = server();
        await expect(
            runCli(['host', 'claude-window-tick', '--profile', '/profiles/selected', '--json'], {
                connect: () => Promise.resolve(client),
                environment: {},
                io: io().io,
            }),
        ).resolves.toBe(0);
        expect(client.request).toHaveBeenCalledWith('claudeWindow.tick', {});
    });

    it('refuses an Agent caller, so an Agent cannot spend a window', async () => {
        const output = io();
        const connect = vi.fn();
        await expect(
            runCli(['host', 'claude-window-tick', '--profile', '/profiles/selected'], {
                connect,
                environment: { CLAUDECODE: '1' },
                io: output.io,
            }),
        ).resolves.not.toBe(0);
        expect(output.stderr()).toContain('human profile owner');
    });
});
