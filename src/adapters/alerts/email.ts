// ZVI v1 — Email Alert Adapter

import nodemailer from 'nodemailer';

export async function sendEmail(title: string, body: string): Promise<void> {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.ALERT_EMAIL_FROM;
  const to = process.env.ALERT_EMAIL_TO;

  if (!host || !to) throw new Error('Email not configured');

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  await transporter.sendMail({
    from: from || 'zvi@localhost',
    to,
    subject: `[ZVI] ${title}`,
    text: body,
  });
}
