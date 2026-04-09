import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { amount, recurring, name, message } = req.body;

  if (!amount || isNaN(amount) || amount < 1) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const amountPence = Math.round(parseFloat(amount) * 100);
  const metadata = { name: name || '', message: message || '' };

  try {
    if (recurring) {
      // Create a customer, then a subscription with an inline price
      const customer = await stripe.customers.create({ name: name || undefined, metadata });

      const price = await stripe.prices.create({
        unit_amount: amountPence,
        currency: 'gbp',
        recurring: { interval: 'month' },
        product_data: { name: 'Platform Monthly Support' },
      });

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
      });

      return res.status(200).json({
        clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      });
    } else {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountPence,
        currency: 'gbp',
        metadata,
      });

      return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
      });
    }
  } catch (err) {
    console.error('Donation error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
