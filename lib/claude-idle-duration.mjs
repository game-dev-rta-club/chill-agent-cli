// Explicit, finite watches can span a day without changing native permissions
// or renewing an expired Stop checkpoint. Keep setup and the hook consistent.
export const defaultClaudeIdleMs=300000;
export const maxClaudeIdleMs=86400000;
export function validateClaudeIdleDuration(value) {
 if(!Number.isSafeInteger(value)||value<1000||value>maxClaudeIdleMs)throw Error(`Idle watch duration/timeout must be 1000–${maxClaudeIdleMs} ms.`);
 return value;
}
