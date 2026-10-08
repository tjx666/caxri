import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentTranscriptLocation, TranscriptScanFailureReason } from '../transcript-security';
import { openSafeAgentTranscript, resolveSafeAgentTranscriptPath } from '../transcript-security';

/**
 * `resolveSafeAgentTranscriptPath` and `openSafeAgentTranscript` are the security boundary issue #1032 asks to keep
 * behaviorally untouched while making its rejections legible. These tests assert both halves: the existing accept/
 * reject decision is unchanged, and the new `report` callback names the exact reason for every reject.
 */
describe('transcript-security failure reporting', () => {
    let home: string;
    let baseRoot: string;
    let root: string;

    beforeEach(async () => {
        // Resolved once up front (macOS puts `/var` behind a `/private/var` symlink) so every path this suite builds
        // and asserts against already matches what `resolveSafeAgentTranscriptPath`'s own `realpath` calls return.
        const created = await mkdtemp(join(tmpdir(), 'caxri-transcript-security-'));
        home = await realpath(created);
        baseRoot = join(home, 'projects');
        root = join(baseRoot, 'worktree');
        await mkdir(root, { recursive: true });
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    function location(path: string): AgentTranscriptLocation {
        return { baseRoot, path, root };
    }

    function reporter(): {
        calls: TranscriptScanFailureReason[];
        report: (reason: TranscriptScanFailureReason) => void;
    } {
        const calls: TranscriptScanFailureReason[] = [];
        return { calls, report: (reason) => calls.push(reason) };
    }

    it('reports missing for a transcript that does not exist yet, and still returns exists: false', async () => {
        const path = join(root, 'session.jsonl');
        const { calls, report } = reporter();

        const safe = await resolveSafeAgentTranscriptPath(location(path), report);

        expect(safe).toEqual({ exists: false, path, root });
        expect(calls).toEqual(['missing']);
    });

    it('reports symlinkRejected for a transcript path that is a symlink, and still declines it', async () => {
        const path = join(root, 'session.jsonl');
        await writeFile(join(home, 'outside.jsonl'), '');
        await symlink(join(home, 'outside.jsonl'), path);
        const { calls, report } = reporter();

        const safe = await resolveSafeAgentTranscriptPath(location(path), report);

        expect(safe).toBeUndefined();
        expect(calls).toEqual(['symlinkRejected']);
    });

    it('reports hardlinkRejected for a transcript with more than one link, and still declines it', async () => {
        const path = join(root, 'session.jsonl');
        const sibling = join(root, 'sibling.jsonl');
        await writeFile(path, 'content');
        await link(path, sibling);
        const { calls, report } = reporter();

        const safe = await resolveSafeAgentTranscriptPath(location(path), report);

        expect(safe).toBeUndefined();
        expect(calls).toEqual(['hardlinkRejected']);
    });

    it('never reports a reason on the path the accepted case takes', async () => {
        const path = join(root, 'session.jsonl');
        await writeFile(path, 'content');
        const { calls, report } = reporter();

        const safe = await resolveSafeAgentTranscriptPath(location(path), report);

        expect(safe).toEqual({ exists: true, path, root });
        expect(calls).toEqual([]);
    });

    it('does not double-report openSafeAgentTranscript rejections that resolveSafeAgentTranscriptPath already named', async () => {
        const path = join(root, 'session.jsonl');
        await writeFile(join(home, 'outside.jsonl'), '');
        await symlink(join(home, 'outside.jsonl'), path);
        const { calls, report } = reporter();

        const opened = await openSafeAgentTranscript(location(path), report);

        expect(opened).toBeUndefined();
        expect(calls).toEqual(['symlinkRejected']);
    });

    it('accepts a plain transcript file through openSafeAgentTranscript without reporting anything', async () => {
        const path = join(root, 'session.jsonl');
        await writeFile(path, 'content');
        const { calls, report } = reporter();

        const opened = await openSafeAgentTranscript(location(path), report);

        expect(opened).toBeDefined();
        await opened?.handle.close();
        expect(calls).toEqual([]);
    });

    it('leaves the accept/reject decision unchanged when report is omitted', async () => {
        const path = join(root, 'session.jsonl');
        await writeFile(join(home, 'outside.jsonl'), '');
        await symlink(join(home, 'outside.jsonl'), path);

        await expect(resolveSafeAgentTranscriptPath(location(path))).resolves.toBeUndefined();
    });

    it('reports structureRejected when a resolved path escapes its declared root', async () => {
        const { calls, report } = reporter();
        // A path that is not a direct child of `root` at all: the pre-lstat ancestry guard.
        const escapee = join(home, 'elsewhere.jsonl');

        const safe = await resolveSafeAgentTranscriptPath(location(escapee), report);

        expect(safe).toBeUndefined();
        expect(calls).toEqual(['structureRejected']);
    });
});
