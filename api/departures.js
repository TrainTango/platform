import { rttFetch } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=5');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const code = (req.query.code || '').toUpperCase().trim();
  if (!code || code.length < 2 || code.length > 5) {
    return res.status(400).json({ error: 'Invalid station code' });
  }

  try {
    const response = await rttFetch(`/gb-nr/location?code=${code}`);
    if (response.status === 204) return res.status(200).json({ services: [] });
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Departures error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch departures' });
  }
}
