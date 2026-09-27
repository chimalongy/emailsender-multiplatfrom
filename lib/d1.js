export async function messageStore(action, data = {}) {
  const base = process.env.MESSAGE_STORE_URL;
  if (!base) throw new Error('Set MESSAGE_STORE_URL in your environment');
  const body = JSON.stringify({ action, ...data });
  const timestamp = String(Date.now());
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-timestamp': timestamp,
    },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `D1 message store failed (${response.status})`);
  return result;
}
