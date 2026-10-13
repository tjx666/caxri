import { z } from 'zod';

/**
 * The identifier and path bounds every contract shares. They live apart from `domain.ts` so a process that validates
 * only a few messages, such as the Terminal Host or the Extension Host, does not load the Project, Session, and
 * settings schemas along with them; see `docs/server-footprint.md`.
 */
export const identifierSchema = z.string().min(1).max(200);
export const pathSchema = z.string().min(1).max(16_384);
