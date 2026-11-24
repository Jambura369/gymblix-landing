// Serves byte ranges for video files.
//
// Workers static assets return the whole file even when the browser asks
// for a range (HTTP 206). Safari on iPhone/iPad needs 206 responses to play
// <video>, so requests for .mp4 files come through this script first
// (see "run_worker_first" in wrangler.jsonc). Every other file is served
// directly as a static asset and never reaches this code.
export default {
  async fetch(request, env) {
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
  },
};
