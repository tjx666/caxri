import type { AppLocale, AppSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    observationIdentity,
    resetSupervisorHarness,
    sessionContextOf,
    supervisorHarness,
} from './service-harness.fixture';

vi.mock('../catalog', async () => (await import('./service-harness.fixture')).catalogModule);
vi.mock('../discovery', async () => (await import('./service-harness.fixture')).discoveryModule);
vi.mock('../supervisor', async () => (await import('./service-harness.fixture')).supervisorModule);

import { ExtensionService } from '../service';

const language: { preference: AppLocale | null } = { preference: null };

function createService(): ExtensionService {
    return new ExtensionService({
        ...observationIdentity,
        appVersion: '0.0.17',
        commit: 'test',
        extensionHostPath: '/out/main/extension-host.js',
        extensionRoots: ['/extensions'],
        includeTestOnly: true,
        logger: new StructuredLogger('/tmp/caxri-extension-language-test', 'server-core', 'error'),
        sessionContext: sessionContextOf(
            () => ({
                ownerProjectId: 'project-1',
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
            }),
            ['project-1'],
        ),
        projectIds: () => Promise.resolve(['project-1']),
        projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
        settings: () =>
            Promise.resolve({
                'workbench.language': language.preference,
            } as unknown as AppSettings),
        workspaceRequest: () => Promise.resolve(null),
    });
}

function languageRequests() {
    return supervisorHarness.requests.filter(({ method }) => method === 'languageChanged');
}

describe('ExtensionService language', () => {
    beforeEach(() => {
        resetSupervisorHarness();
        language.preference = null;
    });

    it('tells the Host about a new language before republishing the catalog', async () => {
        const service = createService();
        await service.start();
        const order: string[] = [];
        service.onCatalogChanged(() => order.push(`catalog after ${languageRequests().length}`));

        language.preference = 'zh-CN';
        await service.settingsChanged();

        expect(languageRequests()).toEqual([
            { method: 'languageChanged', parameters: { locale: 'zh-CN' } },
        ]);
        expect(order).toEqual(['catalog after 1']);
    });

    it('ignores a settings change that leaves the language as it was', async () => {
        const service = createService();
        await service.start();
        const catalogChanges = vi.fn();
        service.onCatalogChanged(catalogChanges);

        await service.settingsChanged();

        expect(languageRequests()).toEqual([]);
        expect(catalogChanges).not.toHaveBeenCalled();
    });

    it('follows the system language while the preference is Follow system', async () => {
        const service = createService();
        await service.start();

        await service.updateLanguage({ systemLanguages: ['zh-CN'] });
        language.preference = 'en';
        await service.settingsChanged();

        expect(languageRequests().map(({ parameters }) => parameters)).toEqual([
            { locale: 'zh-CN' },
            { locale: 'en' },
        ]);
    });
});
