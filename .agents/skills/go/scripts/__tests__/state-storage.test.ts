import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInitialState } from '../state-model';
import { writeInitialState, writeState } from '../state-storage';

describe('Go state storage', () => {
    it('keeps state replacements private to the current user', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-state-mode-'));
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Protect state mode', runId: 'state-mode' });
        try {
            await writeInitialState(path, state);
            await chmod(path, 0o644);
            state.objective = 'Replaced privately';

            await writeState(path, state);

            expect((await stat(path)).mode & 0o777).toBe(0o600);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
