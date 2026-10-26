declare const CURRENT_SCHEMA_VERSION: number;
declare const manifest: { CURRENT_SCHEMA_VERSION: number };
declare const target: { version: number };
declare function setVersion(version: number): void;

setVersion(CURRENT_SCHEMA_VERSION - 1);
setVersion(manifest.CURRENT_SCHEMA_VERSION - 2);
export const pragma = `user_version = ${CURRENT_SCHEMA_VERSION - 1}`;

setVersion(CURRENT_SCHEMA_VERSION);
setVersion(manifest.CURRENT_SCHEMA_VERSION + 1);
setVersion(target.version - 1);
