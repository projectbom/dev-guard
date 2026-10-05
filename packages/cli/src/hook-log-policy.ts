// Hook log rotation. Sized from the real PartnerFlow codex-notify.log
// (1339 events, ~12.6KB/event in the old format: ~7.7KB raw payload +
// ~4.6KB of captured `dev-guard done/status` stdout). The current format
// logs a ~0.5-1KB summary per event, so 2MiB holds thousands of events
// (days of normal use); with 2 rotated generations a hook log never uses
// more than ~6MiB on disk — well under the 10MiB read cap that the old
// verification path used to trip on. Logs are never read for verification
// (see readHookStates in hooks.ts), so rotation can never affect runtimeVerified.
export const HOOK_LOG_ROTATE_BYTES = 2 * 1024 * 1024;
export const HOOK_LOG_GENERATIONS = 2;
