import { copyFile, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Stages the test-only extension as a profile-installed extension for unpackaged E2E launches. Production Server
 * artifacts remain immutable and fixture-free; packaged E2E uses its separately manifested application artifact.
 */
export async function stageDevelopmentTestExtension(
    projectRoot: string,
    userDataDirectory: string,
): Promise<void> {
    const source = join(projectRoot, 'extensions', 'fixture');
    const destination = join(userDataDirectory, 'extensions', 'caxri.fixture');
    await mkdir(destination, { recursive: true });
    await Promise.all([
        copyFile(join(source, 'package.json'), join(destination, 'package.json')),
        cp(join(source, 'dist'), join(destination, 'dist'), { force: true, recursive: true }),
        cp(join(source, 'media'), join(destination, 'media'), { force: true, recursive: true }),
    ]);
}
