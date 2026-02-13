// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Alert Dispatcher
// Sends alerts via all configured channels.
// ═══════════════════════════════════════════════════════════════

import { sendTelegram } from './telegram';
import { sendEmail } from './email';
import { sendWebhook } from './webhook';

/**
 * Send alert through all configured channels.
 * Failures are logged but don't block other channels.
 */
export async function sendAlert(title: string, body: string): Promise<void> {
  const results: string[] = [];

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      await sendTelegram(title, body);
      results.push('telegram:ok');
    } catch (e: any) {
      results.push(`telegram:error:${e.message}`);
    }
  }

  // Email
  if (process.env.SMTP_HOST && process.env.ALERT_EMAIL_TO) {
    try {
      await sendEmail(title, body);
      results.push('email:ok');
    } catch (e: any) {
      results.push(`email:error:${e.message}`);
    }
  }

  // Webhook
  if (process.env.WEBHOOK_URL) {
    try {
      await sendWebhook(title, body);
      results.push('webhook:ok');
    } catch (e: any) {
      results.push(`webhook:error:${e.message}`);
    }
  }

  if (results.length === 0) {
    console.log('[Alerts] No alert channels configured. Alert logged to console only.');
  } else {
    console.log(`[Alerts] Dispatch results: ${results.join(', ')}`);
  }
}
