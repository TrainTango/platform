const RTT_BASE = 'https://data.rtt.io';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }
  const refreshToken = process.env.RTT_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('No RTT_REFRESH_TOKEN set');
  const res = await fetch(`${RTT_BASE}/api/get_access_token`, {
    headers: { Authorization: `Bearer ${refreshToken}` },
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.token;
  tokenExpiresAt = new Date(data.validUntil).getTime();
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const code = (req.query.code || '').toUpperCase().trim();

  try {
    const token = await getAccessToken();

    // Test three different URL formats
    const urls = [
      `${RTT_BASE}/gb-nr/location?code=${code}`,
      `${RTT_BASE}/gb-nr/location?code=WATRLMN`,
      `${RTT_BASE}/rtt/location?code=gb-nr:${code}`,
    ];

    const results = [];
    for (const url of urls) {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      results.push({
        url: url.replace(RTT_BASE, ''),
        status: r.status,
        hasServices: body?.services?.length || 0,
        sample: typeof body === 'object' ? body : text.slice(0, 200),
      });
    }

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
