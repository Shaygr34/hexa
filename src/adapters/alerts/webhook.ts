// ZVI v1 — Generic Webhook Alert Adapter

export async function sendWebhook(title: string, body: string): Promise<void> {
  const url = process.env.WEBHOOK_URL;
  if (!url) throw new Error('Webhook URL not configured');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      body,
      timestamp: new Date().toISOString(),
      source: 'zvi-v1',
    }),
  });

  if (!resp.ok) {
    throw new Error(`Webhook error: ${resp.status}`);
  }
}
