// api/create-payment.js
// Le client appelle cette route pour obtenir une URL de paiement PayDunya.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { montant, uid } = req.body;
    if (!montant || montant <= 0 || !uid) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const response = await fetch('https://app.paydunya.com/api/v1/checkout-invoice/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
        'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
        'PAYDUNYA-PUBLIC-KEY': process.env.PAYDUNYA_PUBLIC_KEY,
        'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN,
      },
      body: JSON.stringify({
        invoice: {
          total_amount: montant,
          description: `Recharge wallet Ludo - ${uid}`,
        },
        store: { name: 'Ludo App' },
        custom_data: { uid }, // récupéré dans payment-webhook.js pour créditer le bon wallet
        actions: {
          callback_url: `${process.env.APP_URL}/api/payment-webhook`,
          return_url: `${process.env.APP_URL}/wallet-success`,
          cancel_url: `${process.env.APP_URL}/wallet-cancel`,
        },
      }),
    });

    const data = await response.json();

    if (data.response_text === 'success') {
      return res.status(200).json({ url: data.checkout_invoice_url, token: data.token });
    }
    console.error('Erreur PayDunya create-invoice:', data);
    return res.status(400).json({ error: 'payment_creation_failed', details: data });
  } catch (err) {
    console.error('Erreur create-payment:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
