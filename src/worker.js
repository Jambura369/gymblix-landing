// Gymblix website Worker. Static files are served straight from ./public;
// only the routes listed in "run_worker_first" (wrangler.jsonc) reach this code:
//   /assets/*.mp4  -> byte ranges, so Safari on iPhone can play the demo video
//   /api/lead      -> demo request form, emailed to the Gymblix inbox
import {EmailMessage} from 'cloudflare:email';

const LEAD_FROM = 'leads@gymblix.com'; // must be on the gymblix.com Email Routing zone
const LEAD_TO = 'gymblix.app@gmail.com'; // must be a verified Email Routing destination
const MEMBER_CHOICES = ['Under 50', '50 – 150', '150 – 500', '500+'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lead') return handleLead(request, env);
    return serveWithRanges(request, env);
  },
};

// ── Demo request form ─────────────────────────────────────────────────
async function handleLead(request, env) {
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
    members: clean(data.members, 20),
    message: clean(data.message, 600),
  };
  if (!lead.name || !lead.gym || !lead.city || !MEMBER_CHOICES.includes(lead.members)) {
    return json({error: 'Please fill in every field.'}, 400);
  }
  if (!/^[6-9]\d{9}$/.test(lead.phone)) {
    return json({error: 'Please enter a valid 10-digit Indian mobile number.'}, 400);
  }

  try {
    await env.LEAD_EMAIL.send(new EmailMessage(LEAD_FROM, LEAD_TO, buildEmail(lead, request)));
  } catch (err) {
    console.error('lead email failed', err && err.message);
    return json({error: 'Sorry, we could not send your request. Please WhatsApp us instead.'}, 502);
  }
  return json({ok: true});
}

function buildEmail(lead, request) {
  const wa = `https://wa.me/91${lead.phone}?text=${encodeURIComponent(
    `Hi ${lead.name}, this is Gymblix. Thanks for requesting a demo for ${lead.gym}!`,
  )}`;
  const when = new Date().toLocaleString('en-IN', {timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'});
  const rows = [
    ['Name', lead.name], ['Gym', lead.gym], ['City', lead.city],
    ['Phone', `+91 ${lead.phone}`], ['Members', lead.members],
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
&nbsp; <a href="tel:+91${lead.phone}">Call +91 ${lead.phone}</a></p>
<p style="color:#888;font-size:12px">Sent from the demo form on gymblix.com</p></div>`;

  const boundary = 'gx' + crypto.randomUUID().replace(/-/g, '');
  const subject = `New demo request: ${lead.gym}, ${lead.city}`;
  return [
    `From: Gymblix Website <${LEAD_FROM}>`,
    `To: ${LEAD_TO}`,
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
