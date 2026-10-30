import { z } from 'zod';

/**
 * V8 flags every Server Core launch passes before its entry: Desktop and the CLI (`@caxri/client/supervise`) and the
 * artifact's own `runtime/caxri-server` launcher an SSH Host runs. Its Workers and the Extension Host inherit them.
 *
 * Left to itself, V8 sizes each young-generation semi-space from the heap limit: up to 64 MiB on a 64-bit host with a 4
 * GiB limit, a 192 MiB young-generation budget that a busy Server Core grows into and never returns. Capped at 8 MiB
 * (as the Terminal Host already is), Server Core under a heavy Git and search workload stayed at about 200 MiB RSS
 * instead of 290 MiB, with the same request latency and the same number of full GCs; scavenges ran half again as often
 * for about 1% more GC time. 16 MiB measured about 210 MiB. This is not a heap ceiling: long-lived state still promotes
 * to the old generation. See `docs/server-footprint.md`.
 */
export const SERVER_CORE_EXEC_ARGV: readonly string[] = ['--max-semi-space-size=8'];

const artifactRelativePathSchema = z
    .string()
    .min(1)
    .max(1_024)
    .refine(
        (path) =>
            !path.startsWith('/') &&
            !path.includes('\\') &&
            path
                .split('/')
                .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
        'Artifact path must stay relative to the Server root',
    );

const serverArtifactFileReceiptSchema = z
    .object({
        mode: z.number().int().min(0).max(0o777),
        path: artifactRelativePathSchema,
        sha256: z.string().regex(/^[a-f\d]{64}$/u),
        size: z.number().int().nonnegative(),
    })
    .strict();

const serverArtifactEntrypointsSchema = z
    .object({
        extensionHost: artifactRelativePathSchema,
        server: artifactRelativePathSchema,
        terminalHost: artifactRelativePathSchema,
    })
    .strict();

const serverArtifactExtensionSchema = z
    .object({
        id: z.string().min(1).max(200),
        path: artifactRelativePathSchema,
    })
    .strict();

const serverArtifactIntegritySchema = z
    .object({
        aggregateSha256: z.string().regex(/^[a-f\d]{64}$/u),
        algorithm: z.literal('sha256'),
        files: z.array(serverArtifactFileReceiptSchema).max(20_000),
    })
    .strict();

const serverArtifactNativeDependencySchema = z
    .object({
        name: z.string().min(1).max(214),
        version: z.string().min(1).max(100),
    })
    .strict();

const serverArtifactRuntimeSchema = z
    .object({
        executable: artifactRelativePathSchema,
        /**
         * Where an SSH Host can fetch the runtime itself instead of receiving it from Desktop: the official tarball,
         * its SHA-256, and the binary's path inside it. Present only on cross-assembled Linux targets.
         */
        source: z
            .object({
                member: z.string().regex(/^node-v[\w.-]+\/bin\/node$/u),
                sha256: z.string().regex(/^[a-f\d]{64}$/u),
                url: z
                    .string()
                    .regex(/^https:\/\/nodejs\.org\/dist\/v[\w.-]+\/node-v[\w.-]+\.tar\.gz$/u),
            })
            .strict()
            .optional(),
        version: z.string().min(1).max(100),
    })
    .strict();

export const serverArtifactManifestSchema = z
    .object({
        architecture: z.string().min(1).max(64),
        artifactKind: z.literal('caxri-server'),
        commit: z.union([z.literal('unknown'), z.string().regex(/^[a-f\d]{8,40}$/u)]),
        entrypoints: serverArtifactEntrypointsSchema,
        extensions: z.array(serverArtifactExtensionSchema).max(1_000),
        integrity: serverArtifactIntegritySchema,
        nativeDependencies: z.array(serverArtifactNativeDependencySchema).max(100),
        platform: z.string().min(1).max(64),
        protocolVersion: z.number().int().positive(),
        runtime: serverArtifactRuntimeSchema,
        schemaVersion: z.literal(2),
        version: z.string().min(1).max(100),
    })
    .strict();

export type ServerArtifactFileReceipt = z.infer<typeof serverArtifactFileReceiptSchema>;
export type ServerArtifactManifest = z.infer<typeof serverArtifactManifestSchema>;
