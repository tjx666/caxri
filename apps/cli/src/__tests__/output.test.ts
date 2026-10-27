import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverServerManifest } from '@caxri/client/supervise';
import {
    isCaxriError,
    PATH_OUTSIDE_PROJECTS_MESSAGE,
    SESSION_SELECTION_REQUIRED_MESSAGE,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    isProfileSelectionSatisfied,
    profileCommandHint,
    quietLines,
    stableJson,
    withNextStep,
} from '../output';

describe('CLI machine output', () => {
    it('sorts JSON keys recursively for stable snapshots', () => {
        expect(stableJson({ z: 1, nested: { b: 2, a: 1 }, a: 0 })).toBe(
            '{"a":0,"nested":{"a":1,"b":2},"z":1}',
        );
    });

    it('projects object and array IDs in quiet mode and rejects ambiguous output', () => {
        expect(quietLines({ id: 'session-1', title: 'Session' })).toEqual(['session-1']);
        expect(quietLines([{ id: 'one' }, { id: 'two' }])).toEqual(['one', 'two']);
        expect(() => quietLines({ state: 'ready' })).toThrow('has no stable ID');
        expect(quietLines([{ sessionId: 'one' }], 'sessionId')).toEqual(['one']);
        expect(() => quietLines({ id: 'one' }, 'sessionId')).toThrow('has no stable ID');
    });
});

describe('profile selection rule', () => {
    const tty = { stdinIsTTY: true, stdoutIsTTY: true };
    const base = { automation: 'human' as const, io: tty, profileFlag: undefined };

    it('allows an interactive human on the default profile', () => {
        expect(isProfileSelectionSatisfied({ ...base, profileSource: 'default' })).toBe(true);
    });

    it.each([
        ['piped stdout', { ...base, io: { ...tty, stdoutIsTTY: false }, profileSource: 'default' }],
        ['agent', { ...base, automation: 'agent' as const, profileSource: 'default' }],
        ['environment profile', { ...base, profileSource: 'environment' }],
    ] as const)('requires --profile for %s', (_name, input) => {
        expect(isProfileSelectionSatisfied(input)).toBe(false);
    });

    it('accepts an explicit flag anywhere', () => {
        expect(
            isProfileSelectionSatisfied({
                automation: 'ci',
                io: { stdinIsTTY: false, stdoutIsTTY: false },
                profileFlag: '/p',
                profileSource: 'argument',
            }),
        ).toBe(true);
    });

    it('quotes the copyable command', () => {
        expect(
            profileCommandHint(['open', '.'], '/Users/me/Library/Application Support/Caxri'),
        ).toBe('caxri open . --profile "/Users/me/Library/Application Support/Caxri"');
    });
});

describe('withNextStep', () => {
    async function discoveryError(path: string) {
        try {
            await discoverServerManifest(path);
        } catch (error) {
            if (isCaxriError(error)) return { code: error.code, message: error.message };
        }
        throw new Error('expected discovery to fail');
    }

    it('adds the app hint to the real server-not-running discovery error', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-next-step-'));
        try {
            const wire = withNextStep(await discoveryError(directory));
            expect(wire.code).toBe('NOT_FOUND');
            expect(wire.message).toContain("Caxri isn't running");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('explains the real missing-profile discovery error', async () => {
        const missingProfile = join(tmpdir(), 'caxri-no-such-profile-dir');
        const wire = withNextStep(await discoveryError(missingProfile));
        expect(wire.message).toContain('profile folder does not exist');
    });

    it('adds next steps to the desktop router path and session errors', () => {
        expect(
            withNextStep({ code: 'PATH_DENIED', message: PATH_OUTSIDE_PROJECTS_MESSAGE }).message,
        ).toContain('caxri project add');
        expect(
            withNextStep({
                code: 'CONFLICT',
                message: SESSION_SELECTION_REQUIRED_MESSAGE,
            }).message,
        ).toContain('caxri session list');
    });
});
