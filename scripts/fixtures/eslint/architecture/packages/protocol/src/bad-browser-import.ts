import { readFile } from 'fs/promises';

export async function unsafeReadFile(): Promise<void> {
    await readFile('/tmp/caxri-architecture-boundary-fixture');
}
