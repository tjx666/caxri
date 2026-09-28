import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('theme contrast import errors', () => {
    it('names the failing surface and exposes measured contrast details', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-contrast-'));
        temporaryDirectories.push(directory);
        const surfaceLabels = {
            background: 'editor background',
            elevated: 'raised panel background',
            surface: 'sidebar and status bar background',
        } as const;
        await Promise.all(
            (['background', 'surface', 'elevated'] as const).map(async (surface) => {
                const path = join(directory, `${surface}.json`);
                const theme = structuredClone(draculaTheme);
                theme.colors[surface] = theme.colors.muted;
                await writeFile(path, JSON.stringify(theme), 'utf8');
                await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
                    code: 'VALIDATION',
                    message: `Secondary text in the imported theme must have at least 4.5:1 contrast against the ${surfaceLabels[surface]}. Choose a lighter or darker secondary text color and try again.`,
                    details: {
                        kind: 'theme-contrast',
                        foregroundRole: 'muted',
                        backgroundRole: surface,
                        actualRatio: 1,
                        requiredRatio: 4.5,
                    },
                } satisfies Partial<CaxriError>);
            }),
        );
    });
});
