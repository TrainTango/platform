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
  res.setHeader('Cache-Control', 's-maxage=15');

  const code = (req.query.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'Missing station code' });

  const to = (req.query.to || '').toUpperCase().trim();

  try {
    const token = await getAccessToken();
    let url = `${RTT_BASE}/gb-nr/location?code=${code}`;
    if (to) url += `&filterTo=${to}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 204) return res.status(200).json({ services: [] });
    if (!response.ok) throw new Error(`RTT returned ${response.status}`);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Departures error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
