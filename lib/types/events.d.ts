import type { ChatId } from './chat.js';
/** Direction of a timeline event. NEVER carries message text. */
export type EventDirection = 'in' | 'out' | 'conn';
/** One timeline event line (memory ring + qq-events.jsonl). No text ever. */
export interface EventLine {
    ts: number;
    d: EventDirection;
    chatId: string;
    kind: string;
    ok: boolean;
    reason: string;
    /** Message id when known. */
    mid?: string | number;
}
/** record() input (ts/mid optional). */
export interface EventInput {
    direction: EventDirection;
    chatId?: string;
    kind?: string;
    ok?: boolean;
    reason?: string;
    messageId?: string | number;
}
/** EventLog stats (healthcheck). */
export interface EventStats {
    recorded: number;
    writeFailures: number;
    rotated: number;
}
/**
 * The event timeline (P0 2026-11-02): in-memory ring + qq-events.jsonl.
 * Metadata only (no message text); loadTail() restores history after restart;
 * 2 MiB rotation keeping 2 generations. Pure bypass: write failures only warn.
 */
export declare class EventLog {
    private readonly dir;
    private readonly log;
    private readonly now;
    private readonly capacity;
    private readonly maxBytes;
    private readonly keepRotated;
    /** Ring buffer (old → new internally). */
    private readonly ring;
    private writeChain;
    private dirEnsured;
    private lastWriteWarnAt;
    /** Sync hook after each record (bridge feeds StatusStore.noteError; throws swallowed). */
    private readonly onRecord;
    private readonly stats;
    constructor(options?: {
        dir: string;
        log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
        now?: () => number;
        onRecord?: (line: EventLine) => void;
        capacity?: number;
        maxBytes?: number;
        keepRotated?: number;
    });
    file(): string;
    /** Record one event (sync into ring + async append; never throws). */
    record(event: EventInput): EventLine;
    /** Most recent `limit` events (newest first); chatId filters when non-empty. */
    recent(limit?: number, chatId?: string): EventLine[];
    /** Read the file tail back into the ring at startup (panel survives restarts). */
    loadTail(limit?: number): Promise<number>;
    /** Today's ok:false count within [dayStartMs, dayEndMs). */
    errorsToday(dayStartMs: number, dayEndMs: number): number;
    private append;
    private fileAtCap;
    private rotate;
    /** Wait for the write chain (self-test / shutdown). */
    flush(): Promise<void>;
    getStats(): EventStats;
}
/** Event file name (appended under mediaDir). */
export declare const EVENTS_FILE = "qq-events.jsonl";
/** Rotated generation file name (qq-events.<generation>.jsonl). */
export declare function eventsRotatedFile(generation: number): string;
/** Per-file size cap (2 MiB, same as qq-inbox.jsonl). */
export declare const EVENTS_MAX_BYTES = 2000000;
/** Rotated generations kept. */
export declare const EVENTS_KEEP_ROTATED = 2;
/** Default ring capacity (upper bound of the panel's display count). */
export declare const DEFAULT_EVENTS_CAPACITY = 500;
