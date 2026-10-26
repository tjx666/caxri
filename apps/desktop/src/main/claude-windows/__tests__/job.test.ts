import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeWindowState, ServerEvent } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { createClaudeWindowJob } from '../job';
import { claudeWindowLaunchAgent, claudeWindowLaunchAgentPlist } from '../launch-agent';

const ON: ClaudeWindowState = {
    account: {
        key: 'k',
        planType: 'pro',
        keepRolling: true,
        keepRollingIsDefault: true,
        firstWorkdayResetMinutes: 600,
    },
    status: 'waitingForAnchor',
    background: 'unknown',
    wakeTimes: [
        { hour: 5, minute: 0 },
        { hour: 10, minute: 1 },
    ],
};
const OFF: ClaudeWindowState = {
    ...ON,
    account: { ...ON.account!, keepRolling: false },
    status: 'off',
    wakeTimes: [],
};

async function fixture(overrides: { isPackaged?: boolean; platform?: NodeJS.Platform } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'caxri-claude-window-job-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    let state = ON;
    let listener: ((event: ServerEvent) => void) | undefined;
    const reported: string[] = [];
    const launchctl = vi.fn<(arguments_: readonly string[]) => Promise<void>>(() =>
        Promise.resolve(),
    );
    const request = vi.fn((method: string, parameters?: unknown) => {
        if (method === 'claudeWindow.reportBackground') {
            const next = (parameters as { state: ClaudeWindowState['background'] }).state;
            reported.push(next);
            state = { ...state, background: next };
            return Promise.resolve<unknown>({ accepted: true });
        }
        return Promise.resolve<unknown>(state);
    });
    const job = createClaudeWindowJob({
        supervisor: {
            request: request as never,
            onEvent: (handler) => {
                listener = handler;
                return () => {};
            },
        },
        isPackaged: overrides.isPackaged ?? true,
        platform: overrides.platform ?? 'darwin',
        home,
        resourcesPath: '/Applications/Caxri.app/Contents/Resources',
        userDataPath: '/profiles/default',
        uid: 501,
        logger: () => {},
        launchctl,
    });
    const agent = claudeWindowLaunchAgent(home, '/profiles/default');
    const settle = async () => {
        await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(0));
        await new Promise((resolve) => setTimeout(resolve, 20));
    };
    return {
        job,
        agent,
        launchctl,
        reported,
        settle,
        set: (next: ClaudeWindowState) => {
            state = { ...next, background: state.background };
        },
        emit: (event: ServerEvent) => listener?.(event),
    };
}

describe('Claude window background job', () => {
    it('registers a launchd job that runs the packaged CLI for this profile at each wake time', async () => {
        const test = await fixture();
        test.job.start();
        await test.settle();
        const plist = await readFile(test.agent.plistPath, 'utf8');
        expect(plist).toContain(
            '<string>/Applications/Caxri.app/Contents/Resources/bin/caxri</string>',
        );
        expect(plist).toContain('<string>claude-window-tick</string>');
        expect(plist).toContain('<string>/profiles/default</string>');
        expect(plist).toMatch(
            /<key>Hour<\/key>\s*<integer>10<\/integer>\s*<key>Minute<\/key>\s*<integer>1<\/integer>/,
        );
        expect(test.launchctl).toHaveBeenCalledWith(['bootstrap', 'gui/501', test.agent.plistPath]);
        expect(test.reported).toEqual(['registered']);
        expect(test.agent.label).not.toContain('profiles');
    });

    it('removes the job when the keeper turns off', async () => {
        const test = await fixture();
        test.job.start();
        await test.settle();
        test.set(OFF);
        test.emit({ event: 'claudeWindow.changed', payload: {} });
        await vi.waitFor(() => expect(test.reported).toEqual(['registered', 'notRegistered']));
        await expect(stat(test.agent.plistPath)).rejects.toThrow();
        expect(test.launchctl).toHaveBeenCalledWith(['bootout', `gui/501/${test.agent.label}`]);
    });

    it('does not rewrite an unchanged job on every change', async () => {
        const test = await fixture();
        test.job.start();
        await test.settle();
        test.emit({ event: 'claudeWindow.changed', payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
            test.launchctl.mock.calls.filter(([arguments_]) => arguments_[0] === 'bootstrap'),
        ).toHaveLength(1);
    });

    it('reports a failed registration and never registers outside a packaged macOS build', async () => {
        const failing = await fixture();
        failing.launchctl.mockImplementation((arguments_) =>
            arguments_[0] === 'bootstrap' ? Promise.reject(new Error('exit 5')) : Promise.resolve(),
        );
        failing.job.start();
        await vi.waitFor(() => expect(failing.reported).toEqual(['registerFailed']));
        // The written plist alone is not a registration: the next sync loads it again.
        failing.launchctl.mockImplementation(() => Promise.resolve());
        failing.emit({ event: 'claudeWindow.changed', payload: {} });
        await vi.waitFor(() => expect(failing.reported).toEqual(['registerFailed', 'registered']));

        const development = await fixture({ isPackaged: false });
        development.job.start();
        await vi.waitFor(() => expect(development.reported).toEqual(['unpackaged']));
        await expect(stat(development.agent.plistPath)).rejects.toThrow();

        const linux = await fixture({ platform: 'linux' });
        linux.job.start();
        await vi.waitFor(() => expect(linux.reported).toEqual(['unsupportedPlatform']));
    });

    it('escapes XML in every value it writes', () => {
        expect(
            claudeWindowLaunchAgentPlist({
                label: 'l',
                launcherPath: '/a&b',
                userDataPath: '/<p>',
                wakeTimes: [],
            }),
        ).toContain('<string>/a&amp;b</string>');
    });
});
