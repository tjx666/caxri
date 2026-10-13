import type { TerminalRecord } from '@caxri/protocol';
import { bugReportText } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import type { BugReportContext, BugReportDraft } from '../bug-report';
import {
    bugReportAgentTargets,
    bugReportImageDeliveryNotice,
    buildBugReport,
    canAttachBugReportScreenshot,
    chooseBugReportTarget,
} from '../bug-report';
import type { ScreenshotAnnotation } from '../screenshot-annotations';
import { ANNOTATION_NOTE_MAX_LENGTH, MAX_ANNOTATIONS } from '../screenshot-annotations';

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
        lastProcessState: 'running',
        lastAgentProcessState: 'running',
        createdAt: 1,
        updatedAt: 1,
        processId: 100,
        ...overrides,
    };
}

const draft: BugReportDraft = {
    actual: 'The action failed.',
    expected: 'The action should finish once.',
    steps: '',
};

const context: BugReportContext = {
    appVersion: '0.0.6',
    architecture: 'arm64',
    commit: 'abcdef1',
    platform: 'darwin',
    project: { id: 'project-1' },
    recentErrorIds: [],
    session: { id: 'session-1' },
    visibleWork: { kind: 'none' },
};

function annotation(overrides: Partial<ScreenshotAnnotation> = {}): ScreenshotAnnotation {
    return {
        id: 'annotation-1',
        kind: 'box',
        note: '',
        x1: 650,
        y1: 250,
        x2: 815,
        y2: 400,
        ...overrides,
    };
}

describe('bug report content', () => {
    it('builds bounded context without leaking secret-shaped user text', () => {
        const report = buildBugReport(
            {
                actual: 'Request failed with token=private-value and {"api_key":"json-private-value"} at https://example.invalid/object?X-Amz-Expires=900&X-Amz-Signature=sigvalue987654321',
                expected: 'No failure for sk-abcdefghijklmnop',
                steps: '1. Open Caxri\n2. Reproduce',
            },
            {
                ...context,
                recentErrorIds: ['server-core:ipc.request_failed:2026-08-11T00:00:00.000Z'],
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
        expect(report).toContain('- Visible work: Claude Terminal (`terminal-1`)');
        expect(report).not.toContain('Bug fix');
        expect(report).not.toContain('Terminal: Agent');
        expect(report).not.toContain('private-value');
        expect(report).not.toContain('json-private-value');
        expect(report).not.toContain('sigvalue987654321');
        expect(report).toContain('https://example.invalid/object?[REDACTED]');
        expect(report).not.toContain('/private/project');
    });

    it('omits the reproduction steps section when the optional field is blank', () => {
        const report = buildBugReport({ ...draft, steps: '   \n  ' }, context);

        expect(report).not.toContain('## Reproduction steps');
        expect(report).toContain(
            '## Expected behavior\nThe action should finish once.\n\n## Caxri',
        );
    });

    it('names the annotated screenshot file and repeats each mark as text', () => {
        const report = buildBugReport(draft, context, {
            annotations: [
                annotation({ note: 'This button is misaligned' }),
                annotation({
                    id: 'annotation-2',
                    kind: 'arrow',
                    note: 'Points at the stale token=private-value badge',
                    x1: 300,
                    y1: 540,
                    x2: 575,
                    y2: 660,
                }),
                annotation({ id: 'annotation-3' }),
            ],
            height: 1250,
            path: '/tmp/caxri-bug-report/screenshot.jpg',
            width: 2000,
        });

        expect(report).toContain(
            '## Screenshot\n- File: `/tmp/caxri-bug-report/screenshot.jpg` (2000×1250 px, annotated)',
        );
        expect(report).toContain('- Open the image file above to see the marked areas.');
        expect(report).toContain(
            '- Annotations:\n  1. [box x=650 y=250 w=165 h=150] This button is misaligned',
        );
        expect(report).toContain('  2. [arrow from (300,540) to (575,660)] Points at the stale');
        expect(report).toContain('  3. [box x=650 y=250 w=165 h=150] (no note)');
        // Annotation notes are user text and must follow the same redaction rules as the report body.
        expect(report).not.toContain('private-value');
        expect(report).toContain('token=[REDACTED]');
    });

    it('records an unannotated screenshot without claiming it has marked areas', () => {
        const report = buildBugReport(draft, context, {
            annotations: [],
            height: 1250,
            path: '/tmp/caxri-bug-report/screenshot.jpg',
            width: 2000,
        });

        expect(report).toContain('- File: `/tmp/caxri-bug-report/screenshot.jpg` (2000×1250 px)');
        expect(report).not.toContain('annotated');
        expect(report).not.toContain('- Annotations:');
    });

    it('omits the screenshot section when no image was captured', () => {
        expect(buildBugReport(draft, context)).not.toContain('## Screenshot');
    });

    /**
     * The UI caps are only trustworthy together: three 12 000-character draft fields plus `MAX_ANNOTATIONS` notes of
     * `ANNOTATION_NOTE_MAX_LENGTH` each, with the numbered location prefix `formatAnnotationLines` adds, still have to
     * fit the `bugReportText` limit. Raising any one of them without checking the others would only fail at send time,
     * after the user typed everything.
     */
    it('keeps a report built from every field at its maximum inside the transport limit', () => {
        const maximumDraft: BugReportDraft = {
            actual: 'a'.repeat(12_000),
            expected: 'e'.repeat(12_000),
            steps: 's'.repeat(12_000),
        };

        const report = buildBugReport(maximumDraft, context, {
            annotations: Array.from({ length: MAX_ANNOTATIONS }, (_unused, index) =>
                annotation({
                    id: `annotation-${index}`,
                    note: 'n'.repeat(ANNOTATION_NOTE_MAX_LENGTH),
                }),
            ),
            height: 1250,
            path: '/tmp/caxri-bug-reports/caxri-bug-report-2026-01-01T00-00-00.000Z-abcdef12.jpg',
            width: 2000,
        });

        expect(bugReportText.safeParse(report).success).toBe(true);
    });
});

describe('bug report target selection', () => {
    it('keeps only live Agent Terminals in the captured Session and prefers the active one', () => {
        const candidates = [
            terminal('claude'),
            terminal('codex', { kind: 'codex', provider: 'codex', processId: 200 }),
            terminal('shell', { kind: 'shell', provider: undefined }),
            terminal('agent-idle', { lastAgentProcessState: 'stopped' }),
            terminal('exited', { processId: undefined, lastProcessState: 'stopped' }),
            terminal('foreign', { sessionId: 'session-2' }),
            terminal('idle-chat', {
                processId: undefined,
                lastProcessState: 'stopped',
                surface: 'chat',
            }),
        ];

        expect(bugReportAgentTargets(candidates, 'session-1').map((item) => item.id)).toEqual([
            'claude',
            'codex',
            'idle-chat',
        ]);
        expect(
            chooseBugReportTarget(candidates, 'session-1', {
                kind: 'terminal',
                terminalId: 'codex',
            }),
        ).toBe('codex');
    });

    it('reports no live target when the Session has no running Agent Terminal', () => {
        expect(bugReportAgentTargets([], 'session-1')).toEqual([]);
        expect(
            bugReportAgentTargets([terminal('exited', { processId: undefined })], 'session-1'),
        ).toEqual([]);
    });

    it('promises the saved file path for every Agent', () => {
        const notice = bugReportImageDeliveryNotice(translate, { provider: 'claude' });

        expect(notice).toContain('saved to a temporary file');
        expect(notice).toContain('the Agent can open it');
        expect(notice).not.toContain('clipboard');
    });

    it('discloses Codex clipboard-backed screenshot delivery before capture', () => {
        const notice = bugReportImageDeliveryNotice(translate, { provider: 'codex' });

        expect(notice).toContain('saved to a temporary file');
        expect(notice).toContain('pasted into this Agent directly');
        expect(notice).toContain('replaces the system clipboard');
    });

    it('attaches the screenshot to a Chat whose provider accepts images, never via the clipboard', () => {
        const notice = bugReportImageDeliveryNotice(translate, {
            provider: 'codex',
            surface: 'chat',
        });

        expect(notice).toContain('attached to the Chat message');
        expect(notice).not.toContain('clipboard');
        expect(canAttachBugReportScreenshot({ provider: 'grok', surface: 'chat' })).toBe(false);
        expect(canAttachBugReportScreenshot({ provider: 'codex' })).toBe(false);
    });
});
