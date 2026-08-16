/* eslint-disable unicorn/name-replacements -- this file's path ('./configuration-contract.js') and its 'configurationSourceSchema' export are referenced from src/runtime/configuration.ts and other files outside this change's authorized scope; renaming either requires a coordinated cross-package edit. */
import { z } from 'zod';

/**
 * Shared wire and disk ceiling for every userData configuration source.
 */
export const MAX_CONFIGURATION_SOURCE_BYTES = 256 * 1024;

/**
 * Prevents a valid but pathological keybinding file from inflating bootstrap and event payloads.
 */
export const MAX_KEYBINDINGS = 1_024;

const textEncoder = new TextEncoder();

/**
 * Measures the actual UTF-8 wire size instead of JavaScript UTF-16 code units.
 */
function configSourceByteLength(source: string): number {
    return textEncoder.encode(source).byteLength;
}

/**
 * Browser-safe source contract shared by IPC parameters, results, and Runtime events.
 */
export const configurationSourceSchema = z
    .string()
    .refine(
        (source) => configSourceByteLength(source) <= MAX_CONFIGURATION_SOURCE_BYTES,
        `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
    );
/* eslint-enable unicorn/name-replacements */
