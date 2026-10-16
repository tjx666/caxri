import process from 'node:process';

/**
 * Configuration loaders run before workspace packages are built. Keep reporter selection independent of the reporter's
 * application protocol dependencies so Node/Jiti can discover every Playwright entry in a clean checkout.
 */
export const publicE2EReporterPath = './scripts/reporters/public-e2e-reporter.ts';
const e2eReceiptReporterPath = './scripts/reporters/e2e-receipt-reporter.ts';

export function shouldUsePublicE2EReporter(environment: NodeJS.ProcessEnv): boolean {
    const ci = environment.CI;
    return (
        environment.GITHUB_ACTIONS === 'true' ||
        (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false')
    );
}

export function playwrightReporterArgument(
    options: {
        environment?: NodeJS.ProcessEnv;
        includeReceipt?: boolean;
    } = {},
): string {
    const environment = options.environment ?? process.env;
    const reporters = [shouldUsePublicE2EReporter(environment) ? publicE2EReporterPath : 'line'];
    if (options.includeReceipt) reporters.push(e2eReceiptReporterPath);
    return `--reporter=${reporters.join(',')}`;
}
