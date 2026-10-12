import { z } from 'zod';

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

export const serverArtifactFileReceiptSchema = z
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
