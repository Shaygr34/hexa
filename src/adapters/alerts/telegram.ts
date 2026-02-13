// ZVI v1 — Telegram Alert Adapter

export async function sendTelegram(title: string, body: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram not configured');

  // Telegram has 4096 char limit; truncate if needed
  const maxLen = 4000;
  let text = `*${title}*\n\n${body}`;
  if (text.length > maxLen) {
    text = text.substring(0, maxLen - 20) + '\n\n... [truncated]';
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telegram API error: ${resp.status} — ${err}`);
  }
}
