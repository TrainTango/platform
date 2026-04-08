import { rttFetch } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await rttFetch('/data/locations');
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Stations error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch stations' });
  }
}
