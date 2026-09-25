import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../android-device.ts', import.meta.url));

describe('Android observe CLI', () => {
    it('rejects invalid text predicates without invoking ADB or echoing the input', () => {
        const privateText = 'private message';
        const serial = ['--serial', 'emulator-5554'];
        const checkId = ['--check-id', 'session-composer-input'];
        const cases = [
            ['observe', ...serial, ...checkId, '--match', 'equals'],
            [
                'observe',
                ...serial,
                ...checkId,
                '--match',
                'equals',
                '--expected-text-base64',
                privateText,
            ],
            [
                'tap',
                ...serial,
                ...checkId,
                '--match',
                'includes',
                '--expected-text-base64',
                Buffer.from(privateText).toString('base64'),
            ],
        ];

        for (const arguments_ of cases) {
            const result = spawnSync('bun', [scriptPath, ...arguments_], {
                encoding: 'utf8',
                shell: false,
                timeout: 5_000,
            });
            expect(result.status).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).not.toContain(privateText);
            expect(result.stderr).not.toContain('adb');
        }
    });
});
