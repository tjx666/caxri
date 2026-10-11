import { MAX_CONFIGURABLE_FILE_BYTES } from '@caxri/protocol';

/**
 * The external-file size limit in human units (DESIGN.md "Settings": byte values render as `2 MB`, never as a raw byte
 * count). The open and save errors share it so they read alike.
 */
export const EXTERNAL_FILE_SIZE_LIMIT_LABEL = `${MAX_CONFIGURABLE_FILE_BYTES / (1024 * 1024)} MB`;
