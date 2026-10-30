import fs, { readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { promises, readFile } from 'node:fs/promises';

import { readBoundedRegularFileText } from '@caxri/system';

export async function fixture(path: string): Promise<void> {
    await readFile(path, 'utf8');
    readFileSync(path, 'utf8');
    fs.readFileSync(path, 'utf8');
    await fs.promises.readFile(path, 'utf8');
    await fsPromises.readFile(path, 'utf8');
    await promises.readFile(path, 'utf8');
    fs.statSync(path);
    await readBoundedRegularFileText(path, 1024);
    // eslint-disable-next-line caxri/bounded-external-reads -- Caxri wrote this file
    await readFile(path, 'utf8');
}
