import type { ChatId } from './chat.js';
/** One queued outbound reply (durable outbox entry). */
export interface OutboxEntry {
    /** Idempotency key (uuid); re-parks during redelivery reuse it. */
    id: string;
    chatId: ChatId;
    /** Cleaned final text (post stripInternalTags/stripSystemContext). */
    text: string;
    queuedAt: number;
    /** Redelivery attempts so far. */
    attempts: number;
}
/** One terminally failed entry (moved off the queue after maxAttempts). */
export interface OutboxFailedEntry extends OutboxEntry {
    reason: string;
    failedAt: number;
}
/** enqueue() result: deduped = an identical (chatId, text) was already queued;
 *  dropped = the oldest entry evicted by the maxEntries cap (never silent). */
export interface OutboxEnqueueResult {
    id: string;
    deduped: boolean;
    dropped: OutboxEntry | undefined;
}
/** Durable outbox stats (settings-page badge / /status / healthcheck). */
export interface OutboxStats {
    enabled: boolean;
    pending: number;
    inFlight: number;
    failed: number;
    loaded: number;
    enqueued: number;
    deduped: number;
    sent: number;
    sendFailed: number;
    dropped: number;
    compacted: number;
    writeFailures: number;
    maxEntries: number;
    maxAttempts: number;
}
/**
 * The durable outbox (P0 2026-11-02): JSONL at mediaDir/qq-outbox.jsonl —
 * at-least-once delivery, idempotency keys, ordered redelivery, restart
 * recovery, bounded failed list. Pure bypass: write failures only warn.
 */
export declare class DurableOutbox {
    private readonly dir;
    private readonly log;
    private readonly now;
    private readonly maxEntries;
    private readonly maxAttempts;
    /** id → entry (Map insertion order = global FIFO). */
    private readonly pending;
    /** Entries handed to due() but not yet acked (crash → rebuilt from file). */
    private readonly inFlight;
    private readonly failed;
    private readonly ackedIds;
    private readonly ackedOrder;
    private readonly stats;
    private writeChain;
    private opsSinceCompact;
    private loadPromise;
    private loaded;
    constructor(options?: {
        dir: string;
        log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
        now?: () => number;
        maxEntries?: number;
        maxAttempts?: number;
    });
    /** Rebuild from disk (idempotent, merge-safe). */
    load(): Promise<number>;
    /** Park one reply; see OutboxEnqueueResult. */
    enqueue(chatId: ChatId, text: string, options?: { id?: string }): OutboxEnqueueResult;
    /** Re-park a due() entry (fresh disconnect mid-drain) under the same id. */
    requeue(id: string): boolean;
    /** Take all pending entries (global FIFO) into inFlight. */
    due(): OutboxEntry[];
    /** Mark one entry delivered (ack line + in-memory id memory). */
    ack(id: string): void;
    /** Record one failed redelivery; 'retry' re-queues, 'failed' is terminal,
     *  'gone' = unknown id. */
    fail(id: string, reason: string): 'retry' | 'failed' | 'gone';
    /** Drop one entry (TTL expiry etc.); returns the dropped entry. */
    drop(id: string, reason: string): OutboxEntry | undefined;
    pendingCount(): number;
    getStats(): OutboxStats;
    recentFailed(limit?: number): OutboxFailedEntry[];
    flush(): Promise<void>;
    private rememberAcked;
    private append;
    private maybeCompact;
    /** Rewrite the file with only pending + failed entries (atomic). */
    compact(): void;
}
/** Outbox file name (appended under mediaDir). */
export declare const OUTBOX_FILE = "qq-outbox.jsonl";
/** Default total queued entries across chats. */
export declare const DEFAULT_OUTBOX_MAX_ENTRIES = 500;
/** Default per-entry redelivery attempts before the failed list. */
export declare const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
