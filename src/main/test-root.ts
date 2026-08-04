interface TestRootOptions {
    environment?: NodeJS.ProcessEnv;
    isPackaged: boolean;
}

/** Exposes the deterministic directory-picker seam only to explicit development E2E runs. */
export function resolveTestRootPath({
    environment = process.env,
    isPackaged,
}: TestRootOptions): string | undefined {
    if (isPackaged || environment.CAXRI_E2E !== '1') return undefined;
    return environment.CAXRI_TEST_ROOT_PATH;
}
