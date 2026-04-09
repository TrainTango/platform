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

    // First check what entitlements we have
    const infoRes = await fetch(`${RTT_BASE}/api/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = await infoRes.json();

    // Try generic endpoint instead of gb-nr
    const rttRes = await fetch(`${RTT_BASE}/rtt/location?code=${code}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rttData = rttRes.status === 204 ? { services: [] } : await rttRes.json();

    return res.status(200).json({
      debug_info: info,
      debug_rtt_status: rttRes.status,
      ...rttData
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
