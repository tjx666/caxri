import type { MobileAndroidAcceptanceCaseId } from './mobile-android-cases';
import { mobileAndroidAcceptanceCase } from './mobile-android-cases';

/**
 * The device operations an adapter-owned scenario needs. The runner binds them to its one explicit emulator serial and
 * deadlines, so this module never selects a device or reads the environment itself.
 */
export interface AndroidBuiltInScenarioContext {
    adbRead: (arguments_: string[]) => string;
    adbRun: (arguments_: string[]) => string;
    /**
     * Hands a scenario the adapter does not own to the Playwright suite.
     */
    executePlaywrightScenario: () => void;
    packageIdentity: () => { debuggable: boolean; versionName: string };
    semanticCheckIds: () => string[];
    serial: string;
    tap: (checkId: string) => void;
    waitForCheck: (checkId: string) => Promise<void>;
    writeScenarioReceipt: (value: Record<string, unknown>) => Promise<void>;
}

const openDeepLink = (context: AndroidBuiltInScenarioContext, url: string): void => {
    context.adbRun([
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        url,
        'com.caxri.mobile',
    ]);
};

const launchApp = (context: AndroidBuiltInScenarioContext): void => {
    context.adbRun(['shell', 'am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
};

/**
 * Runs a scenario the adapter drives directly, or hands it to the Playwright suite.
 */
export async function executeAndroidBuiltInScenario(
    context: AndroidBuiltInScenarioContext,
    caseId: MobileAndroidAcceptanceCaseId,
    { launchId, sourceCommit }: { launchId: string; sourceCommit: string },
): Promise<void> {
    const { scenario } = mobileAndroidAcceptanceCase(caseId);
    switch (scenario) {
        case 'foundation-layout':
            launchApp(context);
            await context.waitForCheck('pairing-entry-screen');
            await context.writeScenarioReceipt({
                package: context.packageIdentity(),
                semanticCheckIds: context.semanticCheckIds(),
                status: 'passed',
            });
            return;
        case 'foundation-cold-start': {
            context.adbRun(['shell', 'am', 'force-stop', 'com.caxri.mobile']);
            const startedAt = Date.now();
            const launch = context.adbRead([
                'shell',
                'am',
                'start',
                '-W',
                'com.caxri.mobile/.MainActivity',
            ]);
            await context.waitForCheck('pairing-entry-screen');
            await context.writeScenarioReceipt({
                interactiveDurationMs: Date.now() - startedAt,
                package: context.packageIdentity(),
                platformReportedTotalTimeMs: Number(/TotalTime:\s*(\d+)/u.exec(launch)?.[1] ?? -1),
                status: 'passed',
            });
            return;
        }
        case 'foundation-inspect':
            launchApp(context);
            await context.waitForCheck('pairing-entry-screen');
            await context.writeScenarioReceipt({
                device: {
                    apiLevel: Number(context.adbRead(['shell', 'getprop', 'ro.build.version.sdk'])),
                    model: context.adbRead(['shell', 'getprop', 'ro.product.model']),
                    release: context.adbRead(['shell', 'getprop', 'ro.build.version.release']),
                    serial: context.serial,
                },
                package: context.packageIdentity(),
                semanticCheckIds: context.semanticCheckIds(),
                status: 'passed',
            });
            return;
        case 'crypto-vector':
            openDeepLink(context, 'caxri://acceptance/crypto');
            await context.waitForCheck('acceptance-crypto-vector-passed');
            await context.writeScenarioReceipt({
                algorithms: ['X25519', 'HKDF-SHA256', 'AES-256-GCM'],
                platform: 'android-release',
                protocolVersion: 1,
                status: 'passed',
                vectorId: 'caxri-mobile-transport-v1',
            });
            return;
        case 'barcode-vector':
            openDeepLink(context, 'caxri://acceptance/barcode');
            await context.waitForCheck('acceptance-barcode-vector-passed');
            await context.writeScenarioReceipt({
                decoder: 'scanFromURLAsync',
                platform: 'android-release',
                status: 'passed',
                vectorId: 'caxri-mobile-barcode-v1',
            });
            return;
        case 'adapter-lifecycle':
            launchApp(context);
            await context.waitForCheck('pairing-entry-screen');
            context.tap('pairing-paste-button');
            await context.waitForCheck('pairing-paste-screen');
            await context.writeScenarioReceipt({
                interaction: 'first-connect-to-paste',
                launchId,
                sourceCommit,
                status: 'passed',
            });
            return;
        default:
            context.executePlaywrightScenario();
    }
}
