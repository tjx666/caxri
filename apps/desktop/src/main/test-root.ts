import process from 'node:process';

interface TestRootOptions {
    environment?: NodeJS.ProcessEnv;
    isPackaged: boolean;
}

function parseQueuedTestRoots(value: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error('CAXRI_TEST_ROOT_PATHS must be a JSON array of paths');
    }
    if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        parsed.some((root) => typeof root !== 'string' || root.length === 0)
    )
        throw new Error('CAXRI_TEST_ROOT_PATHS must be a non-empty JSON array of paths');
    return parsed as string[];
}

/**
 * Exposes the deterministic folder-picker seam only to explicit development E2E runs.
 */
export function resolveTestRootPath({
    environment = process.env,
    isPackaged,
}: TestRootOptions): string | undefined {
    if (isPackaged || environment.CAXRI_E2E !== '1') return undefined;
    return environment.CAXRI_TEST_ROOT_PATH;
}

/**
 * Queues deterministic picker results for multi-Project desktop tests without affecting packages.
 */
export function createTestRootPathResolver({
    environment = process.env,
    isPackaged,
}: TestRootOptions): () => string | undefined {
    let queuedIndex = 0;
    let queuedSource: string | undefined;
    let queuedRoots: string[] | undefined;

    return () => {
        if (isPackaged || environment.CAXRI_E2E !== '1') return;
        const source = environment.CAXRI_TEST_ROOT_PATHS;
        if (!source) return environment.CAXRI_TEST_ROOT_PATH;
        if (source !== queuedSource) {
            queuedSource = source;
            queuedRoots = parseQueuedTestRoots(source);
            queuedIndex = 0;
        }
        const root = queuedRoots![Math.min(queuedIndex, queuedRoots!.length - 1)];
        queuedIndex += 1;
        return root;
    };
}
