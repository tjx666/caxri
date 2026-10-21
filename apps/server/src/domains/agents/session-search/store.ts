import { rm } from 'node:fs/promises';

import type { AgentProvider } from '@caxri/protocol';
import Database from 'better-sqlite3';

/**
 * Bumped whenever the schema or what is extracted from a transcript changes. The index is derived data, so a mismatch
 * drops the file and rebuilds it from the providers' transcripts instead of migrating.
 */
const INDEX_VERSION = 2;

const SCHEMA = `
CREATE TABLE transcripts (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    anchor_root TEXT,
    base_root TEXT NOT NULL,
    root TEXT NOT NULL,
    is_continuation INTEGER NOT NULL,
    inode INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    scan_offset INTEGER NOT NULL,
    skipping_line INTEGER NOT NULL,
    state TEXT NOT NULL,
    cwd TEXT,
    title TEXT,
    indexed_chars INTEGER NOT NULL
);
CREATE INDEX transcripts_conversation ON transcripts(provider, agent_session_id);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    transcript INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX messages_transcript ON messages(transcript);
CREATE VIRTUAL TABLE messages_fts USING fts5(
    text,
    content = 'messages',
    content_rowid = 'id',
    tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
);
CREATE TRIGGER messages_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

/**
 * `conversation` is a top-level conversation a user started in a terminal; `hosted` is one an application started
 * through the Agent SDK (Caxri's Agent Chat among them), searchable only while a Caxri Session holds it; `excluded` is
 * everything else a provider writes beside one (subagent threads, scripted `-p` / `exec` runs, Caxri's own delegated
 * children, a conversation with no prompt yet). Excluded transcripts keep a row so an unchanged file is not inspected
 * again.
 */
type IndexedTranscriptState = 'conversation' | 'excluded' | 'hosted';

/**
 * The states whose messages are indexed and searched.
 */
const SEARCHABLE_STATES = `('conversation', 'hosted')`;

export interface StoredTranscript {
    id: number;
    path: string;
    provider: AgentProvider;
    agentSessionId: string;
    anchorRoot?: string;
    baseRoot: string;
    root: string;
    isContinuation: boolean;
    inode: number;
    size: number;
    mtimeMs: number;
    scanOffset: number;
    isSkippingLine: boolean;
    state: IndexedTranscriptState;
    cwd?: string;
    title?: string;
    indexedChars: number;
}

export type TranscriptUpsert = Omit<StoredTranscript, 'id'>;

export interface IndexedMessage {
    role: 'assistant' | 'user';
    text: string;
}

export interface ContentMatchRow {
    transcript: number;
    hits: number;
    /**
     * FTS5 bm25 rank of the best message: lower is better. Absent for a substring scan, which has no relevance score.
     */
    rank?: number;
    bestMessageId: number;
}

interface TranscriptRow {
    id: number;
    path: string;
    provider: string;
    agent_session_id: string;
    anchor_root: string | null;
    base_root: string;
    root: string;
    is_continuation: number;
    inode: number;
    size: number;
    mtime_ms: number;
    scan_offset: number;
    skipping_line: number;
    state: string;
    cwd: string | null;
    title: string | null;
    indexed_chars: number;
}

function fromRow(row: TranscriptRow): StoredTranscript {
    return {
        id: row.id,
        path: row.path,
        provider: row.provider as AgentProvider,
        agentSessionId: row.agent_session_id,
        ...(row.anchor_root !== null && { anchorRoot: row.anchor_root }),
        baseRoot: row.base_root,
        root: row.root,
        isContinuation: row.is_continuation === 1,
        inode: row.inode,
        size: row.size,
        mtimeMs: row.mtime_ms,
        scanOffset: row.scan_offset,
        isSkippingLine: row.skipping_line === 1,
        state: row.state as IndexedTranscriptState,
        ...(row.cwd !== null && { cwd: row.cwd }),
        ...(row.title !== null && { title: row.title }),
        indexedChars: row.indexed_chars,
    };
}

function toParameters(transcript: TranscriptUpsert) {
    return {
        path: transcript.path,
        provider: transcript.provider,
        agentSessionId: transcript.agentSessionId,
        anchorRoot: transcript.anchorRoot ?? null,
        baseRoot: transcript.baseRoot,
        root: transcript.root,
        isContinuation: transcript.isContinuation ? 1 : 0,
        inode: transcript.inode,
        size: transcript.size,
        mtimeMs: Math.trunc(transcript.mtimeMs),
        scanOffset: transcript.scanOffset,
        skippingLine: transcript.isSkippingLine ? 1 : 0,
        state: transcript.state,
        cwd: transcript.cwd ?? null,
        title: transcript.title ?? null,
        indexedChars: transcript.indexedChars,
    };
}

/**
 * Escapes `%`, `_`, and the escape character itself for a `LIKE ... ESCAPE '\'` substring pattern.
 */
function likePattern(term: string): string {
    return `%${term.replaceAll(/[%_\\]/gu, (character) => `\\${character}`)}%`;
}

function openIndexDatabase(path: string): Database.Database {
    const database = new Database(path);
    try {
        database.pragma('journal_mode = WAL');
        // Derived data: a crash loses at most the last pass, which the next refresh reads again.
        database.pragma('synchronous = OFF');
        const version = database.pragma('user_version', { simple: true }) as number;
        if (version !== INDEX_VERSION) {
            if (version !== 0) throw new Error('Session search index version changed');
            database.exec(SCHEMA);
            database.pragma(`user_version = ${INDEX_VERSION}`);
        }
        return database;
    } catch (error) {
        database.close();
        throw error;
    }
}

/**
 * The persistent Session search index: one row per transcript file with its scan cursor and file identity, and the
 * visible user and Agent messages already read from it under an FTS5 trigram index. Trigrams match any substring, so
 * Chinese and other unspaced text is searchable without a word segmenter.
 *
 * The file holds conversation content, so nothing here may log a message, title, or path.
 */
export class SessionSearchStore {
    /**
     * Opens the index at `path`, deleting and recreating a file left by another index version or one SQLite cannot
     * read: every row can be rebuilt from the transcripts.
     */
    static async open(path: string): Promise<SessionSearchStore> {
        try {
            return new SessionSearchStore(openIndexDatabase(path));
        } catch {
            await Promise.all(
                ['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })),
            );
            return new SessionSearchStore(openIndexDatabase(path));
        }
    }

    private constructor(private readonly database: Database.Database) {}

    close(): void {
        this.database.close();
    }

    transcripts(): StoredTranscript[] {
        return (this.database.prepare('SELECT * FROM transcripts').all() as TranscriptRow[]).map(
            fromRow,
        );
    }

    /**
     * Top-level conversations, terminal-started and hosted, optionally restricted to some providers.
     */
    conversations(providers?: readonly AgentProvider[]): StoredTranscript[] {
        const filter = providers?.length
            ? ` AND provider IN (${providers.map(() => '?').join(', ')})`
            : '';
        return (
            this.database
                .prepare(`SELECT * FROM transcripts WHERE state IN ${SEARCHABLE_STATES}${filter}`)
                .all(...(providers ?? [])) as TranscriptRow[]
        ).map(fromRow);
    }

    conversationTranscripts(provider: AgentProvider, agentSessionId: string): StoredTranscript[] {
        return (
            this.database
                .prepare(
                    `SELECT * FROM transcripts WHERE provider = ? AND agent_session_id = ? AND state = 'conversation'`,
                )
                .all(provider, agentSessionId) as TranscriptRow[]
        ).map(fromRow);
    }

    /**
     * Inserts or replaces the row for `transcript.path` and returns its id.
     */
    saveTranscript(transcript: TranscriptUpsert): number {
        const row = this.database
            .prepare(
                `INSERT INTO transcripts (
                    path, provider, agent_session_id, anchor_root, base_root, root, is_continuation, inode, size,
                    mtime_ms, scan_offset, skipping_line, state, cwd, title, indexed_chars
                ) VALUES (
                    @path, @provider, @agentSessionId, @anchorRoot, @baseRoot, @root, @isContinuation, @inode, @size,
                    @mtimeMs, @scanOffset, @skippingLine, @state, @cwd, @title, @indexedChars
                )
                ON CONFLICT(path) DO UPDATE SET
                    provider = excluded.provider,
                    agent_session_id = excluded.agent_session_id,
                    anchor_root = excluded.anchor_root,
                    base_root = excluded.base_root,
                    root = excluded.root,
                    is_continuation = excluded.is_continuation,
                    inode = excluded.inode,
                    size = excluded.size,
                    mtime_ms = excluded.mtime_ms,
                    scan_offset = excluded.scan_offset,
                    skipping_line = excluded.skipping_line,
                    state = excluded.state,
                    cwd = excluded.cwd,
                    title = excluded.title,
                    indexed_chars = excluded.indexed_chars
                RETURNING id`,
            )
            .get(toParameters(transcript)) as { id: number };
        return row.id;
    }

    updateTitle(id: number, title: string): void {
        this.database.prepare('UPDATE transcripts SET title = ? WHERE id = ?').run(title, id);
    }

    deleteTranscript(id: number): void {
        this.database.transaction(() => {
            this.database.prepare('DELETE FROM messages WHERE transcript = ?').run(id);
            this.database.prepare('DELETE FROM transcripts WHERE id = ?').run(id);
        })();
    }

    clearMessages(id: number): void {
        this.database.prepare('DELETE FROM messages WHERE transcript = ?').run(id);
    }

    /**
     * Appends one scan pass's messages and its advanced cursor in a single transaction, so the cursor never runs ahead
     * of, or behind, the messages it accounts for.
     */
    appendMessages(
        transcript: TranscriptUpsert & { id: number },
        messages: readonly IndexedMessage[],
    ) {
        this.database.transaction(() => {
            const insert = this.database.prepare(
                'INSERT INTO messages (transcript, role, text) VALUES (?, ?, ?)',
            );
            for (const message of messages) insert.run(transcript.id, message.role, message.text);
            this.saveTranscript(transcript);
        })();
    }

    /**
     * Messages matching every full-text term (each at least three characters) and every substring pattern, grouped by
     * transcript with the best-ranked message. A query of only short terms falls back to a substring scan of message
     * text, since trigrams cannot index fewer than three characters.
     */
    contentMatches(
        ftsQuery: string | undefined,
        substrings: readonly string[],
        providers?: readonly AgentProvider[],
    ): ContentMatchRow[] {
        const providerFilter = providers?.length
            ? ` AND t.provider IN (${providers.map(() => '?').join(', ')})`
            : '';
        const substringFilter = substrings
            .map(() => String.raw` AND m.text LIKE ? ESCAPE '\'`)
            .join('');
        const patterns = substrings.map(likePattern);
        if (ftsQuery)
            return this.database
                .prepare(
                    `SELECT m.transcript AS transcript, COUNT(*) AS hits, MIN(f.rank) AS rank, m.id AS bestMessageId
                    FROM messages_fts f
                    JOIN messages m ON m.id = f.rowid
                    JOIN transcripts t ON t.id = m.transcript
                    WHERE messages_fts MATCH ? AND t.state IN ${SEARCHABLE_STATES}${providerFilter}${substringFilter}
                    GROUP BY m.transcript`,
                )
                .all(ftsQuery, ...(providers ?? []), ...patterns) as ContentMatchRow[];
        return this.database
            .prepare(
                `SELECT m.transcript AS transcript, COUNT(*) AS hits, MAX(m.id) AS bestMessageId
                FROM messages m
                JOIN transcripts t ON t.id = m.transcript
                WHERE t.state IN ${SEARCHABLE_STATES}${providerFilter}${substringFilter}
                GROUP BY m.transcript`,
            )
            .all(...(providers ?? []), ...patterns) as ContentMatchRow[];
    }

    /**
     * The best message's excerpt with `\u0001`/`\u0002` around each match.
     *
     * The rowid is cast because better-sqlite3 binds a JavaScript number as REAL, and FTS5 silently ignores a rowid
     * constraint that is not an integer, returning every match instead of the one message.
     */
    snippet(ftsQuery: string, messageId: number): { role: string; snippet: string } | undefined {
        return this.database
            .prepare(
                `SELECT m.role AS role, snippet(messages_fts, 0, char(1), char(2), char(8230), 48) AS snippet
                FROM messages_fts f JOIN messages m ON m.id = f.rowid
                WHERE messages_fts MATCH ? AND f.rowid = CAST(? AS INTEGER)`,
            )
            .get(ftsQuery, messageId) as { role: string; snippet: string } | undefined;
    }

    message(id: number): IndexedMessage | undefined {
        return this.database.prepare('SELECT role, text FROM messages WHERE id = ?').get(id) as
            IndexedMessage | undefined;
    }
}
