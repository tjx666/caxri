import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { vi } from 'vitest';

import type { CliIo, CliServerClient } from '../application';

export function io(options: Partial<CliIo> = {}) {
    let stdout = '';
    let stderr = '';
    const value: CliIo = {
        stderrIsTTY: true,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        writeStderr: (text) => {
            stderr += text;
        },
        writeStdout: (text) => {
            stdout += text;
        },
        ...options,
    };
    return { io: value, stderr: () => stderr, stdout: () => stdout };
}

export function server(
    result: unknown,
    commands = ['host.status', 'host.stop', 'desktop.status', 'desktop.focus'],
): CliServerClient {
    return {
        close: vi.fn(),
        request: vi.fn(() => Promise.resolve(result)),
        requestWithId: vi.fn(() => Promise.resolve(result)),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'cli-test' },
            capabilities: ['desktop.window', 'host.read', 'host.stop'],
            commands,
        } satisfies ProtocolWelcome,
    };
}
