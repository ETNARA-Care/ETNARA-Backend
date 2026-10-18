/** Single-instance, per-admin quota for the opt-in Tower AI pilot. Replace with a shared store before scaling. */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS = 10;
const MAX_KEYS = 10000;
const requests = new Map<string, {count:number; resetAt:number}>();
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, value] of requests) if (value.resetAt <= now) requests.delete(id);
}, 5 * 60 * 1000);
cleanup.unref();

export function reserveTowerAiRequest(userId: string, now = Date.now()): {allowed:boolean;retryAfterSeconds:number} {
  const current = requests.get(userId);
  if (current && current.resetAt > now) {
    if (current.count >= MAX_REQUESTS) return {allowed:false,retryAfterSeconds:Math.max(1,Math.ceil((current.resetAt-now)/1000))};
    current.count += 1;
    return {allowed:true,retryAfterSeconds:0};
  }
  if (!requests.has(userId) && requests.size >= MAX_KEYS) {
    const oldest = requests.keys().next().value;
    if (oldest !== undefined) requests.delete(oldest);
  }
  requests.set(userId,{count:1,resetAt:now+WINDOW_MS});
  return {allowed:true,retryAfterSeconds:0};
}
