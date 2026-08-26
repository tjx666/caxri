import { describe, expect, it } from 'vitest';

import { settingsSpecByKey } from '../../configuration/settings-spec.js';
import {
    businessInternalMethods,
    businessMethods,
    diagnosticsSnapshotSchema,
    logQueryParametersSchema,
    logQueryRecordSchema,
    projectQuerySchema,
    settingsPatchChangeSchema,
    settingsPatchParametersSchema,
    terminalQuerySchema,
} from '../business-contract.js';

describe('projectQuerySchema', () => {
    it('requires a non-empty selector for show mode', () => {
        expect(projectQuerySchema.safeParse({ mode: 'show', selector: '' }).success).toBe(false);
        expect(projectQuerySchema.safeParse({ mode: 'show', selector: 'p1' }).success).toBe(true);
    });

    it('trims the selector before length validation still applies to the raw value', () => {
        // Only whitespace after trim() is treated as empty and rejected.
        expect(
            projectQuerySchema.safeParse({ mode: 'show', selector: ' '.repeat(3) }).success,
        ).toBe(false);
    });

    it('rejects an unknown query mode', () => {
        expect(projectQuerySchema.safeParse({ mode: 'search', selector: 'x' }).success).toBe(false);
    });
});

describe('terminalQuerySchema', () => {
    it('allows list mode without a sessionId filter', () => {
        expect(terminalQuerySchema.safeParse({ mode: 'list' }).success).toBe(true);
    });

    it('allows list mode scoped to a sessionId', () => {
        expect(
            terminalQuerySchema.safeParse({ mode: 'list', sessionId: 'session-1' }).success,
        ).toBe(true);
    });
});

describe('settingsPatchChangeSchema', () => {
    it('enforces the documented terminal.fontSize bounds', () => {
        const { min, max } = settingsSpecByKey['terminal.fontSize'];
        expect(
            settingsPatchChangeSchema.safeParse({ key: 'terminal.fontSize', value: min }).success,
        ).toBe(true);
        expect(
            settingsPatchChangeSchema.safeParse({ key: 'terminal.fontSize', value: max }).success,
        ).toBe(true);
        expect(
            settingsPatchChangeSchema.safeParse({ key: 'terminal.fontSize', value: min - 1 })
                .success,
        ).toBe(false);
        expect(
            settingsPatchChangeSchema.safeParse({ key: 'terminal.fontSize', value: max + 1 })
                .success,
        ).toBe(false);
    });

    it('enforces the documented files.maxFileBytes bounds', () => {
        const { min, max } = settingsSpecByKey['files.maxFileBytes'];
        expect(
            settingsPatchChangeSchema.safeParse({ key: 'files.maxFileBytes', value: min }).success,
        ).toBe(true);
        expect(
            settingsPatchChangeSchema.safeParse({ key: 'files.maxFileBytes', value: max + 1 })
                .success,
        ).toBe(false);
    });

    it('rejects a value shape that does not match its own key', () => {
        expect(
            settingsPatchChangeSchema.safeParse({
                key: 'terminal.copyOnSelect',
                value: 'not-a-boolean',
            }).success,
        ).toBe(false);
    });
});

describe('settingsPatchParametersSchema', () => {
    it('defaults dryRun to false and requires at least one change', () => {
        const parsed = settingsPatchParametersSchema.parse({
            changes: [{ key: 'terminal.copyOnSelect', value: true }],
        });
        expect(parsed.dryRun).toBe(false);
        expect(settingsPatchParametersSchema.safeParse({ changes: [] }).success).toBe(false);
    });

    it('rejects more than the maximum number of changes in one patch', () => {
        const changes = Array.from({ length: 33 }, () => ({
            key: 'terminal.copyOnSelect' as const,
            value: true,
        }));
        expect(settingsPatchParametersSchema.safeParse({ changes }).success).toBe(false);
    });
});

describe('logQueryParametersSchema', () => {
    it('defaults to a bounded limit when no query is supplied', () => {
        expect(logQueryParametersSchema.parse(undefined)).toEqual({ limit: 50 });
    });

    it('rejects a limit outside the allowed range', () => {
        expect(logQueryParametersSchema.safeParse({ limit: 0 }).success).toBe(false);
        expect(logQueryParametersSchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it('accepts registered event filters and rejects unknown events', () => {
        expect(logQueryParametersSchema.safeParse({ event: 'server_core.ready' }).success).toBe(
            true,
        );
        expect(logQueryParametersSchema.safeParse({ event: 'runtime.typo' }).success).toBe(false);
    });

    it('keeps returned event names open for legacy and external JSONL records', () => {
        expect(
            logQueryRecordSchema.safeParse({
                id: 'record-1',
                timestamp: '2026-08-22T00:00:00.000Z',
                process: 'server-core',
                level: 'info',
                event: 'external.legacy_event',
            }).success,
        ).toBe(true);
    });
});

describe('businessMethods', () => {
    it('keeps every public business command Server-owned', () => {
        for (const spec of Object.values(businessMethods)) {
            expect(spec.owner).toBe('server');
        }
    });

    it('gives project.list a principal-scoped projection function', () => {
        expect(typeof businessMethods['project.list'].projectResult).toBe('function');
    });

    it('rejects a negative afterCursor for events.query', () => {
        expect(businessMethods['events.query'].params.safeParse({ afterCursor: -1 }).success).toBe(
            false,
        );
        expect(businessMethods['events.query'].params.safeParse({ afterCursor: 0 }).success).toBe(
            true,
        );
    });
});

describe('diagnosticsSnapshotSchema', () => {
    it('accepts only content-free Terminal Host lifecycle and pressure fields', () => {
        const snapshot = {
            appVersion: '0.0.18',
            protocolVersion: 2,
            runtimeStatus: 'ready',
            startedAt: 1,
            activePtyCount: 1,
            projectCount: 1,
            sessionCount: 1,
            terminalCount: 1,
            recentErrorIds: [],
            performance: [],
            terminalHost: {
                state: 'ready',
                pid: 42,
                startedAt: 1,
                restartCount: 0,
                pendingRequestCount: 2,
                activeTerminalCount: 1,
                attachedTerminalCount: 1,
                inputQueueCount: 1,
                queuedInputCharacters: 12,
                resizeQueueCount: 1,
            },
        };

        expect(diagnosticsSnapshotSchema.safeParse(snapshot).success).toBe(true);
        expect(
            diagnosticsSnapshotSchema.safeParse({
                ...snapshot,
                terminalHost: { ...snapshot.terminalHost, output: 'private-output' },
            }).success,
        ).toBe(false);
    });
});

describe('businessInternalMethods', () => {
    it('requires an explicit principal alongside every internal query', () => {
        const parameters = businessInternalMethods['project.queryForPrincipal'].params;
        expect(parameters.safeParse({ query: { mode: 'list' } }).success).toBe(false);
    });
});
