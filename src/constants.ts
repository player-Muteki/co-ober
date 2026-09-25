export const ACP_LIST_SESSIONS_LIMIT = 100;
export const ACP_LIST_SESSIONS_MAX_PAGES = 10;
/** session/load runs unbounded but fails fast when the replay stalls. */
export const ACP_LOAD_SESSION_IDLE_TIMEOUT_MS = 30_000;
export const ACP_RECONNECT_BACKOFF_BASE_MS = 2000;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const SCROLL_NEAR_BOTTOM_THRESHOLD = 50;
export const CONTEXT_METER_WARNING_PCT = 75;
export const CONTEXT_METER_CRITICAL_PCT = 90;
export const K_FORMAT_THRESHOLD = 1000;
export const STREAM_SAVE_DEBOUNCE_MS = 500;
export const SAVE_NOTICE_THROTTLE_MS = 5 * 60 * 1000;
/** Total base64 image payload kept in data.json; older images are stripped first. */
export const STORED_IMAGE_BUDGET_BYTES = 8 * 1024 * 1024;
export const COPY_BUTTON_RESET_MS = 1500;
export const THINKING_TIMER_INTERVAL_MS = 1000;
export const PERMISSION_TRUNCATE_LENGTH = 50;
export const PERMISSION_MAX_LOCATIONS = 3;
export const PERMISSION_SUMMARY_MAX_KEYS = 3;
export const NOTECACHE_MAX_SIZE = 100;
export const REQUEST_DEFAULT_TIMEOUT_MS = 30000;
export const REQUEST_DEFAULT_MAX_OUTPUT_BYTES = 100000;
/** Marker appended to text content truncated to fit a byte cap (wire payloads, not UI). */
export const TRUNCATION_MARKER = '... [truncated]';
/** Default byte cap for a note read into prompt context. */
export const CONTEXT_NOTE_MAX_BYTES = 8000;
/** Max characters of sqlite stderr kept when reporting a query failure. */
export const SQLITE_STDERR_MAX_CHARS = 2000;
/** Turns shorter than this render no tok/s figure — the rate would mislead. */
export const MIN_THROUGHPUT_SAMPLE_MS = 1000;
/** Max characters of zod detail surfaced when a server request cannot be parsed. */
export const UNREADABLE_SUMMARY_MAX_CHARS = 240;
/** Max characters of the elicitation requestSchema JSON shown as a banner title. */
export const ELICITATION_SCHEMA_MAX_CHARS = 500;
/** Upper bound on assistant-message references the stream controller tracks; oldest evicted first. */
export const MAX_TRACKED_ASSISTANT_MESSAGES = 500;
/** Concurrent prompt streams the client admits before rejecting with a capacity error. */
export const MAX_CONCURRENT_STREAMS = 4;
/** Idle per-session normalizers kept alive before LRU eviction. */
export const MAX_SESSION_NORMALIZERS = 32;
