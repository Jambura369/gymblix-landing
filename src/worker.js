// Gymblix website Worker. Static files are served straight from ./public;
// only the routes listed in "run_worker_first" (wrangler.jsonc) reach this code:
//   /assets/*.mp4  -> byte ranges, so Safari on iPhone can play the demo video
//   /api/lead      -> demo request form, emailed to the Gymblix inbox; if the
//                     visitor gave an email, they also get a "thanks" email
//                     (sent through Resend, only when RESEND_API_KEY is set)
import {EmailMessage} from 'cloudflare:email';

const LEAD_FROM = 'leads@gymblix.com'; // must be on the gymblix.com Email Routing zone
const LEAD_TO = 'gymblix.app@gmail.com'; // must be a verified Email Routing destination
const CONFIRM_FROM = 'Gymblix <hello@gymblix.com>'; // gymblix.com must be verified in Resend
const SUPPORT_EMAIL = 'gymblix.app@gmail.com'; // where the visitor's replies go
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MEMBER_CHOICES = ['Under 50', '50 – 150', '150 – 500', '500+'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lead') return handleLead(request, env, ctx);
    return serveWithRanges(request, env);
  },
};

// ── Demo request form ─────────────────────────────────────────────────
async function handleLead(request, env, ctx) {
  if (request.method !== 'POST') return json({error: 'Method not allowed'}, 405);

  let data;
  try {
    const type = request.headers.get('Content-Type') || '';
    data = type.includes('application/json')
      ? await request.json()
      : Object.fromEntries(await request.formData());
  } catch {
    return json({error: 'Could not read the form. Please try again.'}, 400);
  }

  // Bots fill in the hidden "website" field; pretend it worked.
  if (clean(data.website)) return json({ok: true});

  const lead = {
    name: clean(data.name, 80),
    gym: clean(data.gym, 100),
    city: clean(data.city, 60),
    phone: clean(data.phone, 20).replace(/[^0-9]/g, '').replace(/^(91|0)(?=\d{10}$)/, ''),
    email: clean(data.email, 120).toLowerCase(),
    members: clean(data.members, 20),
    message: clean(data.message, 600),
  };
  if (!lead.name || !lead.gym || !lead.city || !MEMBER_CHOICES.includes(lead.members)) {
    return json({error: 'Please fill in every field.'}, 400);
  }
  if (!/^[6-9]\d{9}$/.test(lead.phone)) {
    return json({error: 'Please enter a valid 10-digit Indian mobile number.'}, 400);
  }
  if (lead.email && !EMAIL_RE.test(lead.email)) {
    return json({error: 'Please check your email address, or leave it empty.'}, 400);
  }

  try {
    await env.LEAD_EMAIL.send(new EmailMessage(LEAD_FROM, LEAD_TO, buildEmail(lead, request)));
  } catch (err) {
    console.error('lead email failed', err && err.message);
    return json({error: 'Sorry, we could not send your request. Please WhatsApp us instead.'}, 502);
  }
  // The lead is safe in our inbox; the visitor's "thanks" email must never fail the form.
  if (lead.email && env.RESEND_API_KEY) ctx.waitUntil(sendConfirmation(lead, env));
  return json({ok: true});
}

function buildEmail(lead, request) {
  const wa = `https://wa.me/91${lead.phone}?text=${encodeURIComponent(
    `Hi ${lead.name}, this is Gymblix. Thanks for requesting a demo for ${lead.gym}!`,
  )}`;
  const when = new Date().toLocaleString('en-IN', {timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'});
  const rows = [
    ['Name', lead.name], ['Gym', lead.gym], ['City', lead.city],
    ['Phone', `+91 ${lead.phone}`], ['Email', lead.email || '—'], ['Members', lead.members],
    ['Message', lead.message || '—'], ['Received', `${when} IST`],
  ];
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nWhatsApp: ${wa}\nCall: tel:+91${lead.phone}\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">
<h2 style="margin:0 0 12px">New demo request</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="color:#666">${k}</td><td><b>${esc(v)}</b></td></tr>`)
    .join('')}</table>
<p style="margin-top:18px">
<a href="${wa}" style="background:#C6FF00;color:#0B0F0E;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Reply on WhatsApp</a>
&nbsp; <a href="tel:+91${lead.phone}">Call +91 ${lead.phone}</a>${lead.email
    ? ` &nbsp; <a href="mailto:${esc(lead.email)}">Email ${esc(lead.email)}</a>` : ''}</p>${lead.email
    ? '<p style="color:#666;font-size:13px">Tip: just press Reply in Gmail to answer them by email.</p>' : ''}
<p style="color:#888;font-size:12px">Sent from the demo form on gymblix.com</p></div>`;

  const boundary = 'gx' + crypto.randomUUID().replace(/-/g, '');
  const subject = `New demo request: ${lead.gym}, ${lead.city}`;
  return [
    `From: Gymblix Website <${LEAD_FROM}>`,
    `To: ${LEAD_TO}`,
    ...(lead.email ? [`Reply-To: ${encodeHeader(lead.name)} <${lead.email}>`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@gymblix.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// ── "Thanks" email to the visitor ─────────────────────────────────────
// Email Routing can only send to our own verified inbox, so mail to visitors
// goes through Resend (free tier). Replies to it land in SUPPORT_EMAIL.
const CONFIRM = {
  en: {
    subject: 'We got your demo request - Gymblix',
    hi: n => `Hi ${n},`,
    body: (g, p) => [
      `Thanks for your interest in Gymblix for <b>${g}</b>.`,
      `We'll WhatsApp or call you on <b>+91 ${p}</b> within 24 hours to set up your free demo.`,
      'Meanwhile, you can watch the 1-minute app tour:',
    ],
    cta: 'Watch the demo',
    help: 'Questions? Just reply to this email or WhatsApp us on +91 70018 95484.',
    sign: 'Team Gymblix',
  },
  bn: {
    subject: 'আপনার ডেমো রিকোয়েস্ট পেয়েছি - Gymblix',
    hi: n => `নমস্কার ${n},`,
    body: (g, p) => [
      `<b>${g}</b>-এর জন্য Gymblix-এ আগ্রহ দেখানোর জন্য ধন্যবাদ।`,
      `ফ্রি ডেমোর জন্য আমরা ২৪ ঘণ্টার মধ্যে <b>+91 ${p}</b> নম্বরে WhatsApp বা কল করব।`,
      'ততক্ষণ ১ মিনিটের অ্যাপ ট্যুরটা দেখে নিন:',
    ],
    cta: 'ডেমো দেখুন',
    help: 'কোনো প্রশ্ন? এই ইমেলের রিপ্লাই দিন বা +91 70018 95484-এ WhatsApp করুন।',
    sign: 'টিম Gymblix',
  },
  hi: {
    subject: 'आपकी डेमो रिक्वेस्ट मिल गई - Gymblix',
    hi: n => `नमस्ते ${n},`,
    body: (g, p) => [
      `<b>${g}</b> के लिए Gymblix में रुचि दिखाने के लिए धन्यवाद।`,
      `फ्री डेमो के लिए हम 24 घंटे के अंदर <b>+91 ${p}</b> पर WhatsApp या कॉल करेंगे।`,
      'तब तक 1 मिनट का ऐप टूर देख लीजिए:',
    ],
    cta: 'डेमो देखें',
    help: 'कोई सवाल? इस ईमेल का जवाब दें या +91 70018 95484 पर WhatsApp करें।',
    sign: 'टीम Gymblix',
  },
};

async function sendConfirmation(lead, env) {
  const c = CONFIRM[lead.lang] || CONFIRM.en;
  const page = lead.lang === 'en' ? 'https://gymblix.com/' : `https://gymblix.com/${lead.lang}/`;
  const lines = c.body(esc(lead.gym), lead.phone);
  const html = `<div style="background:#f4f5f2;padding:24px 12px;font-family:Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">
<div style="background:#0B0F0E;padding:18px 24px"><img src="https://gymblix.com/assets/gymblix-logo.png" alt="Gymblix" height="36" style="display:block;height:36px"></div>
<div style="padding:24px;font-size:15px;line-height:1.6;color:#111">
<p style="margin:0 0 12px">${esc(c.hi(lead.name))}</p>
${lines.map(l => `<p style="margin:0 0 12px">${l}</p>`).join('\n')}
<p style="margin:18px 0"><a href="${page}#demo" style="background:#C6FF00;color:#0B0F0E;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">${c.cta}</a></p>
<p style="margin:0 0 12px;color:#555">${c.help}</p>
<p style="margin:0">${c.sign}<br><a href="${page}" style="color:#555">gymblix.com</a></p>
</div></div></div>`;
  const text = [c.hi(lead.name), '', ...lines.map(l => l.replace(/<\/?b>/g, '')), `${c.cta}: ${page}#demo`, '', c.help, '', c.sign, page]
    .join('\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        from: CONFIRM_FROM, to: [lead.email], reply_to: SUPPORT_EMAIL,
        subject: c.subject, html, text,
      }),
    });
    if (!res.ok) console.error('confirmation email failed', res.status, await res.text());
  } catch (err) {
    console.error('confirmation email failed', err && err.message);
  }
}

const clean = (v, max = 200) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const b64 = s => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{76}/g, '$&\r\n');
};
const encodeHeader = s => `=?UTF-8?B?${b64(s).replace(/\r\n/g, '')}?=`;
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});

// ── Byte ranges for video (Safari) ────────────────────────────────────
async function serveWithRanges(request, env) {
  const res = await env.ASSETS.fetch(request);
  const range = request.headers.get('Range');
  if (res.status !== 200) return res;

  const headers = new Headers(res.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (!range) return new Response(res.body, {status: 200, headers});

  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start;
  let end;
  if (m && m[1] === '' && m[2] !== '') {
    start = Math.max(size - Number(m[2]), 0); // "bytes=-500": last 500 bytes
    end = size - 1;
  } else if (m && m[1] !== '') {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start === undefined || start > end || start >= size) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.delete('Content-Length');
    return new Response(null, {status: 416, headers});
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(buf.slice(start, end + 1), {status: 206, headers});
}
