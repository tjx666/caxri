import { describe, expect, it } from 'vitest';

import type { TranscriptSessionContextScan } from '../transcript-session-context';
import {
    createTranscriptSessionContextScan,
    resetTranscriptSessionContextScan,
    scanTranscriptSessionContextLine,
} from '../transcript-session-context';

function scanned(lines: readonly string[]): TranscriptSessionContextScan {
    const scan = createTranscriptSessionContextScan();
    for (const line of lines) scanTranscriptSessionContextLine(line, scan);
    return scan;
}

const claudeRecord = (
    type: 'assistant' | 'user',
    content: unknown,
    extra: Record<string, unknown> = {},
) => JSON.stringify({ type, cwd: '/repo', gitBranch: 'main', message: { content }, ...extra });

describe('transcript session context scanning', () => {
    it('collects the working directories and branches a conversation named, most recent last', () => {
        const scan = scanned([
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't1', input: { command: 'cd /repo/worktrees/alpha' } },
            ]),
            claudeRecord('assistant', [
                {
                    type: 'tool_use',
                    id: 't2',
                    input: { command: 'git -C /repo/worktrees/beta log' },
                },
            ]),
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't3', input: { command: 'git switch feat/router' } },
            ]),
        ]);
        // Every Claude record repeats the Session's own `cwd`, so `/repo` keeps moving to the end as records arrive;
        // the worktrees it visited keep their own relative order.
        expect(scan.directories).toEqual([
            '/repo/worktrees/alpha',
            '/repo/worktrees/beta',
            '/repo',
        ]);
        expect(scan.branches).toEqual(['main', 'feat/router']);
    });

    it('moves a re-mentioned directory to the most recent position instead of duplicating it', () => {
        const scan = scanned([
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't1', input: { command: 'cd /repo/alpha' } },
            ]),
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't2', input: { command: 'cd /repo/beta' } },
            ]),
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't3', input: { command: 'cd /repo/alpha' } },
            ]),
        ]);
        expect(scan.directories).toEqual(['/repo/beta', '/repo', '/repo/alpha']);
    });

    it('reads Linear markers from both roles and upgrades a bare marker with a later URL workspace', () => {
        const scan = scanned([
            claudeRecord('user', [{ type: 'text', text: 'please finish ABC-42 today' }]),
            claudeRecord('assistant', [
                { type: 'text', text: 'see https://linear.app/acme/issue/abc-42/router' },
            ]),
        ]);
        expect(scan.linearReferences).toEqual([{ identifier: 'ABC-42', workspace: 'acme' }]);
    });

    it('ignores markers quoted inside a harness instruction envelope', () => {
        const scan = scanned([
            claudeRecord('user', [
                {
                    type: 'text',
                    text: '<system-reminder>reference issues as ABC-123</system-reminder>\nfix the router',
                },
            ]),
        ]);
        expect(scan.linearReferences).toEqual([]);
    });

    it('ignores tool output, so a printed log cannot backfill directories or markers', () => {
        const scan = scanned([
            claudeRecord('user', [
                {
                    type: 'tool_result',
                    tool_use_id: 't1',
                    content: 'cd /repo/unrelated && echo XYZ-99',
                },
            ]),
        ]);
        expect(scan.directories).toEqual(['/repo']);
        expect(scan.linearReferences).toEqual([]);
    });

    it('reads Codex rollout records: session cwd, exec workdir, and prose', () => {
        const scan = scanned([
            JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call',
                    name: 'exec',
                    input: 'tools.exec_command({cmd:"git status", "workdir":"/repo/worktrees/gamma"})',
                },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'this is for ABC-7' }],
                },
            }),
        ]);
        expect(scan.directories).toEqual(['/repo', '/repo/worktrees/gamma']);
        expect(scan.linearReferences).toEqual([{ identifier: 'ABC-7' }]);
    });

    it('keeps accumulating across incremental visits and starts over after a reset', () => {
        const scan = createTranscriptSessionContextScan();
        scanTranscriptSessionContextLine(
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't1', input: { command: 'cd /repo/alpha' } },
            ]),
            scan,
        );
        scanTranscriptSessionContextLine(
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't2', input: { command: 'cd /repo/beta' } },
            ]),
            scan,
        );
        expect(scan.directories).toEqual(['/repo/alpha', '/repo', '/repo/beta']);
        resetTranscriptSessionContextScan(scan);
        expect(scan.directories).toEqual([]);
        expect(scan.branches).toEqual([]);
        expect(scan.linearReferences).toEqual([]);
        scanTranscriptSessionContextLine(
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't3', input: { command: 'cd /repo/gamma' } },
            ]),
            scan,
        );
        expect(scan.directories).toEqual(['/repo', '/repo/gamma']);
    });

    it('survives a malformed line and a record it does not understand', () => {
        const scan = scanned([
            'not json at all, but it mentions cd /repo/alpha',
            JSON.stringify({ type: 'token_usage_record', payload: { total: 1 } }),
            claudeRecord('assistant', [{ type: 'text', text: 'done' }]),
        ]);
        expect(scan.directories).toEqual(['/repo']);
    });

    it('refuses prefixes that are standards and model names rather than teams', () => {
        const scan = scanned([
            claudeRecord('user', [
                {
                    type: 'text',
                    text: 'Per RFC-2119 the UTF-8 SHA-256 AES-256 GPT-4 CVE-2024 ISO-8601 path needs ABC-42.',
                },
            ]),
        ]);
        expect(scan.linearReferences).toEqual([{ identifier: 'ABC-42' }]);
    });

    it('keeps the opening marker when a long run of false ones follows it', () => {
        // Comfortably more than a conversation produces by accident, and comfortably inside the bound: the marker the
        // user opened with has to survive the Agent quoting two dozen lookalikes back at it.
        const noise = Array.from({ length: 24 }, (_, index) => `TEAM${index}-7`).join(' ');
        const scan = scanned([
            claudeRecord('user', [{ type: 'text', text: 'Start with ABC-42.' }]),
            claudeRecord('assistant', [{ type: 'text', text: noise }]),
        ]);
        expect(scan.linearReferences.some((reference) => reference.identifier === 'ABC-42')).toBe(
            true,
        );
    });

    it('collects the acceptance reports a conversation linked, most recent last', () => {
        const first = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
        const second = 'f0e1d2c3-b4a5-4968-8778-695a4b3c2d1e';
        const scan = scanned([
            claudeRecord('user', [
                { type: 'text', text: `check https://app.lobehub.com/acceptance/${first}?r=2` },
            ]),
            claudeRecord('assistant', [
                {
                    type: 'tool_use',
                    id: 't1',
                    input: { command: `open https://app.lobehub.com/acceptance/${second}` },
                },
            ]),
        ]);
        expect(scan.acceptanceReferences).toEqual([{ id: first, round: 2 }, { id: second }]);
    });

    it('moves a re-mentioned report to the most recent position, and lets a later round replace an earlier one', () => {
        const id = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
        const other = 'f0e1d2c3-b4a5-4968-8778-695a4b3c2d1e';
        const scan = scanned([
            claudeRecord('user', [
                { type: 'text', text: `https://app.lobehub.com/acceptance/${id}?turn=1` },
            ]),
            claudeRecord('user', [
                { type: 'text', text: `https://app.lobehub.com/acceptance/${other}` },
            ]),
            claudeRecord('assistant', [
                { type: 'text', text: `https://app.lobehub.com/acceptance/${id}?turn=3` },
            ]),
        ]);
        expect(scan.acceptanceReferences).toEqual([{ id: other }, { id, round: 3 }]);
    });

    it('keeps a known round when the report is mentioned again without one', () => {
        const id = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
        const scan = scanned([
            claudeRecord('user', [
                { type: 'text', text: `https://app.lobehub.com/acceptance/${id}?turn=2` },
            ]),
            claudeRecord('assistant', [
                { type: 'text', text: `done: https://app.lobehub.com/acceptance/${id}` },
            ]),
        ]);
        expect(scan.acceptanceReferences).toEqual([{ id, round: 2 }]);
    });

    it('bounds the worktree flag run so a pathological command line cannot stall the scan', () => {
        const flags = '-f '.repeat(60);
        const started = performance.now();
        const scan = scanned([
            claudeRecord('assistant', [
                { type: 'tool_use', id: 't1', input: { command: `git worktree add ${flags}` } },
            ]),
            claudeRecord('assistant', [
                {
                    type: 'tool_use',
                    id: 't2',
                    input: { command: 'git worktree add -b feat/x /repo/worktrees/x' },
                },
            ]),
        ]);
        expect(performance.now() - started).toBeLessThan(250);
        expect(scan.directories).toContain('/repo/worktrees/x');
    });
});
