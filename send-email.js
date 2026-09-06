#!/usr/bin/env node
// Sends the market digest via Gmail SMTP. Zero dependencies (node tls only).
// Adapted from ~/flip-notifier/send-email.js, with HTML body support.
//
// Usage: node send-email.js "subject" "body" [--html]
//
// Requires FLIP_GMAIL_APP_PASSWORD (reuses the same Keychain entry as flip-notifier):
//   security find-generic-password -a darup67@gmail.com -s flip-notifier-gmail -w

'use strict';
const tls = require('tls');

const GMAIL_USER = 'darup67@gmail.com';
const APP_PASSWORD = process.env.FLIP_GMAIL_APP_PASSWORD;
if (!APP_PASSWORD) { process.stderr.write('FLIP_GMAIL_APP_PASSWORD not set\n'); process.exit(1); }

const argv = process.argv.slice(2);
const isHtml = argv.includes('--html');
const [subject, body] = argv.filter(a => a !== '--html');
if (!subject) { process.stderr.write('Usage: send-email.js "subject" "body" [--html]\n'); process.exit(1); }

// Recipient override, else self-send.
const TO = process.env.ZILLOW_AGENT_TO || GMAIL_USER;

const HARD_TIMEOUT_MS = 45000;
setTimeout(() => { process.stderr.write('hard timeout\n'); process.exit(1); }, HARD_TIMEOUT_MS).unref();

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;

function dotStuff(text) {
  return text.replace(/\r?\n/g, '\r\n').replace(/^\.(?=.)/gm, '..');
}

// RFC 2047 encode the subject so emoji / non-ASCII survive.
function encodeSubject(s) {
  return /^[\x20-\x7E]*$/.test(s)
    ? s
    : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function buildMessage() {
  const stuffed = dotStuff(body || subject);
  return [
    `From: Zillow Agent <${GMAIL_USER}>`,
    `To: ${TO}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`,
    '',
    stuffed,
  ].join('\r\n');
}

function attempt() {
  return new Promise((resolve, reject) => {
    const msg = buildMessage();
    const commands = [
      null,
      'EHLO zillowagent',
      `AUTH PLAIN ${Buffer.from(`\0${GMAIL_USER}\0${APP_PASSWORD}`).toString('base64')}`,
      `MAIL FROM:<${GMAIL_USER}>`,
      `RCPT TO:<${TO}>`,
      'DATA',
      `${msg}\r\n.`,
      'QUIT',
    ];

    let step = 0, buf = '', done = false, sock;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve();
    };

    try {
      sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {});
    } catch (e) { return reject(e); }

    sock.setEncoding('utf8');
    sock.setTimeout(20000, () => finish(new Error('socket timeout')));

    sock.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (line[3] === '-') continue;
        if (code >= 500) return finish(new Error(`permanent: ${line}`));
        if (code >= 400) return finish(new Error(`transient: ${line}`));
        step++;
        if (step < commands.length) sock.write(commands[step] + '\r\n');
        else finish(null);
      }
    });

    sock.on('error', e => finish(e));
    sock.on('close', () => finish(new Error('connection closed unexpectedly')));
  });
}

async function sendWithRetry() {
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await attempt();
      process.stdout.write('email sent\n');
      process.exit(0);
    } catch (e) {
      lastErr = e;
      if (e.message && e.message.startsWith('permanent:')) {
        process.stderr.write(`smtp permanent error: ${e.message}\n`);
        process.exit(1);
      }
      if (i < MAX_RETRIES - 1) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, i);
        process.stderr.write(`attempt ${i + 1} failed (${e.message}), retrying in ${delay}ms\n`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  process.stderr.write(`email failed after ${MAX_RETRIES} attempts: ${lastErr.message}\n`);
  process.exit(1);
}

sendWithRetry();
