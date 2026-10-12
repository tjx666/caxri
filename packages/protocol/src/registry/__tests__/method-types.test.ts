import { describe, expect, it } from 'vitest';

import type { CaxriRequest } from '../../index';
import {
    commandRecoveryFor,
    effectfulCommandRecovery,
    getMethodSpec,
    isCaxriMethod,
    isDesktopRequest,
    isMainRequest,
    isServerRequest,
    methods,
} from '../../index';

describe('isCaxriMethod', () => {
    it('accepts a public method name and rejects an internal-only or unknown name', () => {
        expect(isCaxriMethod('project.list')).toBe(true);
        expect(isCaxriMethod('app.windowState.get')).toBe(false);
        expect(isCaxriMethod('not.a.method')).toBe(false);
    });
});

describe('session.rename parameters', () => {
    it('rejects line breaks and control characters before a title can reach an Agent CLI', () => {
        const schema = methods['session.rename'].params;

        expect(() =>
            schema.parse({ sessionId: 'session-1', displayTitle: 'First line\n/compact' }),
        ).toThrow('Session name must be a single line without control characters');
        expect(
            schema.parse({ sessionId: 'session-1', displayTitle: '  Focused investigation  ' }),
        ).toEqual({ sessionId: 'session-1', displayTitle: 'Focused investigation' });
    });
});

describe('owner narrowing guards', () => {
    it('routes a desktop-owned method through isDesktopRequest/isMainRequest only', () => {
        const request = { method: 'processExplorer.open', params: {} } as CaxriRequest;
        expect(isDesktopRequest(request)).toBe(true);
        expect(isMainRequest(request)).toBe(true);
        expect(isServerRequest(request)).toBe(false);
    });

    it('routes a server-owned method through isServerRequest only', () => {
        const request = { method: 'project.list', params: {} } as CaxriRequest;
        expect(isServerRequest(request)).toBe(true);
        expect(isDesktopRequest(request)).toBe(false);
        expect(isMainRequest(request)).toBe(false);
    });
});

describe('getMethodSpec', () => {
    it('resolves a public method, an internal-only method, and returns undefined otherwise', () => {
        expect(getMethodSpec('project.list')?.owner).toBe('server');
        expect(getMethodSpec('app.windowState.get')?.owner).toBe('server');
        expect(getMethodSpec('not.a.method')).toBeUndefined();
    });
});

describe('command recovery policy', () => {
    it('classifies every effectful public method explicitly', () => {
        const effectfulMethods = Object.entries(methods)
            .filter(([, specification]) => specification.effect !== 'read')
            .map(([method]) => method)
            .toSorted((left, right) => left.localeCompare(right));

        expect(
            Object.keys(effectfulCommandRecovery).toSorted((left, right) =>
                left.localeCompare(right),
            ),
        ).toEqual(effectfulMethods);
    });

    it('keeps content-bearing replies in memory while allowing reviewed structural receipts', () => {
        expect(commandRecoveryFor('project.list')).toBe('none');
        expect(commandRecoveryFor('terminal.input')).toBe('none');
        expect(commandRecoveryFor('session.updateState')).toBe('memory');
        expect(commandRecoveryFor('files.write')).toBe('memory');
        expect(commandRecoveryFor('terminal.attach')).toBe('none');
        expect(commandRecoveryFor('terminal.detach')).toBe('none');
        expect(commandRecoveryFor('session.rename')).toBe('durable');
        expect(commandRecoveryFor('terminal.create')).toBe('durable');
    });

    it('admits Terminal stream setup and traffic without asynchronous fingerprint reordering', () => {
        expect(methods['terminal.attach'].idempotency).toBe('none');
        expect(methods['terminal.detach'].idempotency).toBe('none');
        expect(methods['terminal.input'].idempotency).toBe('none');
        expect(methods['terminal.resize'].idempotency).toBe('none');
    });

    it('never persists ephemeral native paths or arbitrary failure messages', () => {
        expect(commandRecoveryFor('dialog.selectDirectory')).toBe('memory');
        expect(commandRecoveryFor('dialog.selectPaths')).toBe('memory');
        expect(commandRecoveryFor('diagnostics.export')).toBe('memory');
        expect(commandRecoveryFor('extensions.retry')).toBe('memory');
        expect(commandRecoveryFor('updates.download')).toBe('memory');
        expect(commandRecoveryFor('updates.cancel')).toBe('memory');
        expect(commandRecoveryFor('updates.open')).toBe('memory');
    });
});
