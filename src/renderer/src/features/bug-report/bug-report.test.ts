import { describe, expect, it } from 'vitest';

import type { TerminalRecord } from '@shared/types';

import {
    bugReportImageFallback,
    buildBugReport,
    chooseBugReportTarget,
    runningAgentTargets,
} from './bug-report';

function terminal(id: string, overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id,
        sessionId: 'session-1',
        kind: 'claude',
        provider: 'claude',
        cwd: '/private/project',
        title: id,
        icon: 'terminal',
        orderIndex: 0,
        layoutNodeId: 'root',
        lastProcessState: 'running',
        createdAt: 1,
        updatedAt: 1,
        processId: 100,
        ...overrides,
    };
}

describe('bug report content', () => {
    it('builds bounded context without leaking secret-shaped user text', () => {
        const report = buildBugReport(
            {
                actual: 'Request failed with token=private-value at https://example.invalid/object?X-Amz-Expires=900&X-Amz-Signature=sigvalue987654321',
                expected: 'No failure for sk-abcdefghijklmnop',
                steps: '1. Open Caxri\n2. Reproduce',
            },
            {
                appVersion: '0.0.6',
                architecture: 'arm64',
                commit: 'abcdef1',
                platform: 'darwin',
                project: { id: 'project-1' },
                recentErrorIds: ['runtime:ipc.request_failed:2026-08-11T00:00:00.000Z'],
                session: { id: 'session-1' },
                visibleWork: {
                    kind: 'terminal',
                    provider: 'claude',
                    terminalId: 'terminal-1',
                },
            },
        );

        expect(report).toContain('## Actual behavior\nRequest failed with token=[REDACTED]');
        expect(report).toContain('## Expected behavior\nNo failure for [REDACTED]');
        expect(report).toContain('## Reproduction steps\n1. Open Caxri\n2. Reproduce');
        expect(report).toContain('- Caxri: 0.0.6 (abcdef1)');
        expect(report).toContain('- Project ID: `project-1`');
        expect(report).toContain('- Session ID: `session-1`');
        expect(report).toContain('- Visible work: Claude Code Terminal (`terminal-1`)');
        expect(report).not.toContain('Bug fix');
        expect(report).not.toContain('Terminal: Agent');
        expect(report).not.toContain('private-value');
        expect(report).not.toContain('sigvalue987654321');
        expect(report).toContain('https://example.invalid/object?[REDACTED]');
        expect(report).not.toContain('/private/project');
    });
});

describe('bug report target selection', () => {
    it('keeps only live Agent Terminals in the captured Session and prefers the active one', () => {
        const candidates = [
            terminal('claude'),
            terminal('codex', { kind: 'codex', provider: 'codex', processId: 200 }),
            terminal('shell', { kind: 'shell', provider: undefined }),
            terminal('exited', { processId: undefined, lastProcessState: 'stopped' }),
            terminal('foreign', { sessionId: 'session-2' }),
        ];

        expect(runningAgentTargets(candidates, 'session-1').map((item) => item.id)).toEqual([
            'claude',
            'codex',
        ]);
        expect(
            chooseBugReportTarget(candidates, 'session-1', {
                kind: 'terminal',
                terminalId: 'codex',
            }),
        ).toBe('codex');
    });

    it('explains why a Codex screenshot remains preview-only before capture', () => {
        const notice = bugReportImageFallback('codex');

        expect(notice).toContain('preview-only');
        expect(notice).toContain('system clipboard');
        expect(notice).toContain('manually');
    });
});
