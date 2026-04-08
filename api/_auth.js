const RTT_BASE = 'https://data.rtt.io';

let cachedToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const refreshToken = process.env.RTT_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('RTT_REFRESH_TOKEN not configured');
  }

  const res = await fetch(`${RTT_BASE}/api/get_access_token`, {
    headers: { Authorization: `Bearer ${refreshToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.token;
  tokenExpiresAt = new Date(data.validUntil).getTime();
  return cachedToken;
}

export async function rttFetch(path) {
  const token = await getAccessToken();
  return fetch(`${RTT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
