import { describe, expect, it } from 'vitest';

import { currentBackgroundWork, runAsBackgroundWork } from '../../../observability/background-work';
import { GitCommandBudget } from '../command-budget';
import { sharedGitRequest } from '../request-signal';

/**
 * A command the test finishes by hand, recording when it started.
 */
function controlled(started: string[], name: string) {
    const done = Promise.withResolvers<void>();
    return {
        finish: done.resolve,
        run: () => {
            started.push(name);
            return done.promise;
        },
    };
}

function budget(maximum: number, state: { background: boolean; loaded: boolean }) {
    return new GitCommandBudget(maximum, {
        isBackground: () => state.background,
        isLoaded: () => state.loaded,
    });
}

describe('GitCommandBudget', () => {
    it('starts a queued foreground command before an earlier queued background one', async () => {
        const state = { background: false, loaded: false };
        const commands = budget(1, state);
        const started: string[] = [];
        const holder = controlled(started, 'holder');
        const background = controlled(started, 'background');
        const foreground = controlled(started, 'foreground');

        const settled = [commands.run(holder.run)];
        state.background = true;
        settled.push(commands.run(background.run));
        state.background = false;
        settled.push(commands.run(foreground.run));
        await expect.poll(() => started).toEqual(['holder']);

        holder.finish();
        await expect.poll(() => started).toEqual(['holder', 'foreground']);
        foreground.finish();
        await expect.poll(() => started).toEqual(['holder', 'foreground', 'background']);
        background.finish();
        await Promise.all(settled);
    });

    it('holds background commands to two slots while the machine is loaded, leaving the rest to foreground', async () => {
        const state = { background: true, loaded: true };
        const commands = budget(8, state);
        const started: string[] = [];
        const background = ['b1', 'b2', 'b3'].map((name) => controlled(started, name));
        const settled = background.map((command) => commands.run(command.run));
        await expect.poll(() => started).toEqual(['b1', 'b2']);

        state.background = false;
        const foreground = controlled(started, 'f1');
        settled.push(commands.run(foreground.run));
        await expect.poll(() => started).toEqual(['b1', 'b2', 'f1']);

        background[0].finish();
        await expect.poll(() => started).toEqual(['b1', 'b2', 'f1', 'b3']);
        for (const command of [...background, foreground]) command.finish();
        await Promise.all(settled);
    });

    it('runs background commands on the whole budget while the machine is idle', async () => {
        const commands = budget(4, { background: true, loaded: false });
        const started: string[] = [];
        const background = ['b1', 'b2', 'b3', 'b4'].map((name) => controlled(started, name));
        for (const command of background) void commands.run(command.run);
        await expect.poll(() => started).toEqual(['b1', 'b2', 'b3', 'b4']);
        for (const command of background) command.finish();
    });

    it('runs a shared producer a poll started as foreground, so a request joining it is not capped', async () => {
        const classes = await runAsBackgroundWork('project-status-poll', async () => [
            currentBackgroundWork(),
            await sharedGitRequest(() => Promise.resolve(currentBackgroundWork())),
        ]);
        expect(classes).toEqual(['project-status-poll', undefined]);
    });
});
