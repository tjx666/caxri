import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { expect } from 'vitest';

export function fixtureExecutable(
    fixture: { executables: Partial<Record<AgentProvider, string>> },
    provider: AgentProvider,
): string {
    const executable = fixture.executables[provider];
    expect(executable).toBeTypeOf('string');
    if (!executable) throw new Error(`Missing ${provider} fixture executable`);
    return executable;
}

export async function readReceipts(root: string): Promise<Array<Record<string, unknown>>> {
    try {
        return (await readFile(join(root, 'acceptance-receipts.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

export async function waitForReceiptCount(
    root: string,
    event: string,
    count: number,
): Promise<void> {
    await expect
        .poll(
            async () =>
                (await readReceipts(root)).filter((receipt) => receipt.event === event).length,
            { interval: 25, timeout: 3_000 },
        )
        .toBeGreaterThanOrEqual(count);
}
