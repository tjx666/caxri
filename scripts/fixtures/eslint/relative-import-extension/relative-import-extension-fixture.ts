import { value } from './target';
import type { Value } from '../relative-import-extension/target';
export { value as reExported } from './target';
export * from './target';
export const loaded = import('./target');

import { value as withExtension } from './target.js';
import { join } from 'node:path';
export { value as reExportedWithExtension } from './target.js';
export * from '../relative-import-extension/target.js';
export const loadedWithExtension = import('./target.js');
export const computed = import(`./${String(value)}`);
export const sample: Value = withExtension;
export { join };
