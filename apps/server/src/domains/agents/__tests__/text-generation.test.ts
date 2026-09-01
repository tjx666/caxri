import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { runAgentTextCommand } from '../text-generation';

describe('runAgentTextCommand', () => {
    it('preserves UTF-8 characters split across stdout chunks', async () => {
        const script = `
const bytes = Buffer.from('中文😀');
process.stdout.write(bytes.subarray(0, 2));
setTimeout(() => {
  process.stdout.write(bytes.subarray(2, 8));
  setTimeout(() => process.stdout.end(bytes.subarray(8)), 10);
}, 10);
`;

        await expect(
            runAgentTextCommand({
                arguments: ['-e', script],
                cwd: process.cwd(),
                environment: process.env,
                executable: process.execPath,
                input: '',
                operation: 'split UTF-8 fixture',
            }),
        ).resolves.toBe('中文😀');
    });
});
