import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { desktopCommandEnvironment } from '../../.agents/skills/switch-worktree/scripts/switch-worktree';
import {
    e2eWorkerTemporaryDirectory,
    removeE2ETemporaryDirectory,
    resolveE2ELaunchPolicy,
    resolveE2EWorkerIsolation,
} from '../../e2e/support/worker-isolation';

describe('E2E worker isolation', () => {
    it('passes the desktop coordinator token only to the wrapped command environment', () => {
        const source = { PATH: '/bin' };
        const environment = desktopCommandEnvironment(
            source,
            '01234567-89ab-cdef-0123-456789abcdef',
        );

        expect(environment).toEqual({
            CAXRI_DESKTOP_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
            PATH: '/bin',
        });
        expect(source).toEqual({ PATH: '/bin' });
    });

    it('derives a stable lease namespace from Playwright parallel index', () => {
        expect(
            resolveE2EWorkerIsolation({
                CAXRI_E2E_POOL: 'parallel-safe',
                CAXRI_E2E_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
                TEST_PARALLEL_INDEX: '1',
            }),
        ).toEqual({
            coordinatorToken: '01234567-89ab-cdef-0123-456789abcdef',
            leaseNamespace: 'e2e-worker-1',
            workerNamespace: 'parallel-safe-1',
        });
    });

    it('uses the repository-wide lease outside the parallel-safe pool', () => {
        expect(resolveE2EWorkerIsolation({})).toEqual({});
        expect(resolveE2EWorkerIsolation({ CAXRI_E2E_POOL: 'desktop-exclusive' })).toEqual({});
    });

    it('skips clipboard protection only for parallel-safe launches and rejects clipboard access there', () => {
        const hidden = { clipboard: false, gpuMode: 'disabled', windowMode: 'hidden' } as const;
        expect(resolveE2ELaunchPolicy({}, hidden)).toEqual({ protectClipboard: true });
        expect(resolveE2ELaunchPolicy({ CAXRI_E2E_POOL: 'desktop-exclusive' }, hidden)).toEqual({
            protectClipboard: true,
        });
        expect(resolveE2ELaunchPolicy({ CAXRI_E2E_POOL: 'parallel-safe' }, hidden)).toEqual({
            protectClipboard: false,
        });
        expect(() =>
            resolveE2ELaunchPolicy(
                { CAXRI_E2E_POOL: 'parallel-safe' },
                { ...hidden, clipboard: true },
            ),
        ).toThrow('clipboard access is not parallel-safe');
    });

    it('allows only a disposable hosted launch without clipboard access to skip protection', () => {
        const hidden = { clipboard: false, gpuMode: 'disabled', windowMode: 'hidden' } as const;
        const hosted = {
            CAXRI_E2E_CLIPBOARD_PROTECTION: 'skip-hosted',
            CI: 'true',
            RUNNER_ENVIRONMENT: 'github-hosted',
        };

        expect(resolveE2ELaunchPolicy(hosted, hidden)).toEqual({ protectClipboard: false });
        expect(() => resolveE2ELaunchPolicy(hosted, { ...hidden, clipboard: true })).toThrow(
            'cannot skip clipboard protection',
        );
        expect(() =>
            resolveE2ELaunchPolicy(
                { CAXRI_E2E_CLIPBOARD_PROTECTION: 'skip-hosted', CI: 'true' },
                hidden,
            ),
        ).toThrow('disposable GitHub-hosted CI runner');
        expect(() =>
            resolveE2ELaunchPolicy(
                {
                    CAXRI_E2E_CLIPBOARD_PROTECTION: 'disabled',
                    CI: 'true',
                    RUNNER_ENVIRONMENT: 'github-hosted',
                },
                hidden,
            ),
        ).toThrow('must be skip-hosted');
        expect(() =>
            resolveE2ELaunchPolicy(
                { ...hosted, CAXRI_E2E_POOL: 'parallel-safe' },
                { ...hidden, windowMode: 'visible' },
            ),
        ).toThrow("windowMode: 'visible' is not parallel-safe");
    });

    it('rejects visible windows and an enabled GPU only inside the parallel-safe pool', () => {
        const hidden = { clipboard: false, gpuMode: 'disabled', windowMode: 'hidden' } as const;
        const parallel = { CAXRI_E2E_POOL: 'parallel-safe' };

        expect(() =>
            resolveE2ELaunchPolicy(parallel, { ...hidden, windowMode: 'visible' }),
        ).toThrow("windowMode: 'visible' is not parallel-safe");
        expect(() => resolveE2ELaunchPolicy(parallel, { ...hidden, gpuMode: 'enabled' })).toThrow(
            "gpuMode: 'enabled' is not parallel-safe",
        );
        for (const environment of [{}, { CAXRI_E2E_POOL: 'desktop-exclusive' }]) {
            expect(() =>
                resolveE2ELaunchPolicy(environment, {
                    clipboard: true,
                    gpuMode: 'enabled',
                    windowMode: 'visible',
                }),
            ).not.toThrow();
        }
    });

    it('nests a focused E2E launch beneath the switch-worktree desktop coordinator', () => {
        expect(
            resolveE2EWorkerIsolation({
                CAXRI_DESKTOP_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
            }),
        ).toEqual({
            coordinatorToken: '01234567-89ab-cdef-0123-456789abcdef',
            leaseNamespace: 'e2e-desktop-command',
        });
        expect(() =>
            resolveE2EWorkerIsolation({ CAXRI_DESKTOP_COORDINATOR_TOKEN: 'invalid' }),
        ).toThrow('valid coordinator token');
    });

    it('places profiles, roots, logs, and PTYs below the Playwright worker directory', () => {
        expect(
            e2eWorkerTemporaryDirectory('/tmp', {
                workerNamespace: 'parallel-safe-1',
            }),
        ).toBe('/tmp/caxri-e2e-parallel-safe-1');
        expect(e2eWorkerTemporaryDirectory('/tmp', {})).toBeUndefined();
    });

    it('bounds recursive worker cleanup while a late nested file appears', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'caxri-e2e-worker-cleanup-'));
        const workerDirectory = join(parent, 'caxri-e2e-parallel-safe-1');
        const sibling = join(parent, 'preserve.txt');
        await mkdir(workerDirectory, { recursive: true });
        await writeFile(sibling, 'preserve', 'utf8');
        let removeCalls = 0;
        const delays: number[] = [];

        try {
            await removeE2ETemporaryDirectory(workerDirectory, {
                remove: async (path, options) => {
                    removeCalls += 1;
                    expect(path).toBe(workerDirectory);
                    expect(options).toEqual({ force: true, recursive: true });
                    if (removeCalls === 1) {
                        await mkdir(join(workerDirectory, 'shell-integration'), {
                            recursive: true,
                        });
                        await writeFile(
                            join(workerDirectory, 'shell-integration', 'late.json'),
                            '{}',
                            'utf8',
                        );
                        throw Object.assign(new Error('late worker entry'), {
                            code: 'ENOTEMPTY',
                            path: workerDirectory,
                        });
                    }
                    return rm(path, options);
                },
                wait: (delay) => {
                    delays.push(delay);
                    return Promise.resolve();
                },
            });

            expect(removeCalls).toBe(2);
            expect(delays).toEqual([100]);
            await expect(access(workerDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(sibling, 'utf8')).resolves.toBe('preserve');
        } finally {
            await rm(parent, { force: true, recursive: true });
        }
    });

    it('propagates the final worker cleanup error unchanged', async () => {
        const path = '/tmp/caxri-e2e-parallel-safe-1';
        const failures = Array.from({ length: 4 }, (_, index) =>
            Object.assign(new Error(`worker cleanup attempt ${index + 1} stayed non-empty`), {
                code: 'ENOTEMPTY',
                path,
            }),
        );
        const delays: number[] = [];
        let attempt = 0;

        await expect(
            removeE2ETemporaryDirectory(path, {
                remove: () => Promise.reject(failures[attempt++]),
                wait: (delay) => {
                    delays.push(delay);
                    return Promise.resolve();
                },
            }),
        ).rejects.toBe(failures.at(-1));
        expect(attempt).toBe(4);
        expect(delays).toEqual([100, 200, 300]);
    });

    it('fails closed when Playwright does not provide a valid parallel index', () => {
        expect(() => resolveE2EWorkerIsolation({ CAXRI_E2E_POOL: 'parallel-safe' })).toThrow(
            'TEST_PARALLEL_INDEX',
        );
        expect(() =>
            resolveE2EWorkerIsolation({
                CAXRI_E2E_POOL: 'parallel-safe',
                CAXRI_E2E_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
                TEST_PARALLEL_INDEX: '../shared',
            }),
        ).toThrow('TEST_PARALLEL_INDEX');
        expect(() =>
            resolveE2EWorkerIsolation({
                CAXRI_E2E_POOL: 'parallel-safe',
                TEST_PARALLEL_INDEX: '0',
            }),
        ).toThrow('coordinator token');
    });
});
