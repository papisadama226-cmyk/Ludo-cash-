// api/payment-webhook.js
// PayDunya appelle cette URL (callback_url) après un paiement.
// Configure-la dans create-payment.js -> actions.callback_url
// et déclare-la aussi sur ton dashboard PayDunya si demandé.

import admin from 'firebase-admin';

// --- Init Firebase Admin (une seule fois) ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Sur Vercel, les retours à la ligne de la clé privée sont échappés (\\n)
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // PayDunya envoie les données du paiement en POST (form-urlencoded ou JSON selon config)
    const data = req.body?.data ? JSON.parse(req.body.data) : req.body;

    const status = data?.status; // "completed" si succès
    const token = data?.invoice?.token;
    const customFields = data?.custom_data || {}; // on y aura mis le uid à la création

    if (status !== 'completed') {
      // Paiement annulé/échoué : on log et on répond 200 quand même (PayDunya attend un 200)
      console.log('Paiement non complété:', status, token);
      return res.status(200).json({ received: true });
    }

    // --- Vérification anti-fraude : on re-confirme le statut auprès de PayDunya ---
    // (ne JAMAIS faire confiance uniquement au contenu du webhook reçu)
    const verifyResponse = await fetch(
      'https://app.paydunya.com/api/v1/checkout-invoice/confirm/' + token,
      {
        headers: {
          'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
          'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
          'PAYDUNYA-PUBLIC-KEY': process.env.PAYDUNYA_PUBLIC_KEY,
          'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN,
        },
      }
    );
    const verifyData = await verifyResponse.json();

    if (verifyData.status !== 'completed') {
      console.warn('Webhook prétend "completed" mais confirmation PayDunya dit non:', verifyData);
      return res.status(200).json({ received: true, ignored: true });
    }

    const uid = verifyData.custom_data?.uid;
    const montant = Number(verifyData.invoice?.total_amount);

    if (!uid || !montant) {
      console.error('uid ou montant manquant', verifyData);
      return res.status(200).json({ received: true, error: 'missing_uid_or_amount' });
    }

    // --- Idempotence : on ne crédite jamais deux fois le même paiement ---
    const txRef = db.collection('transactions').doc(token);
    const walletRef = db.collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const txSnap = await t.get(txRef);
      if (txSnap.exists) {
        // déjà traité, on ne fait rien
        return;
      }
      const walletSnap = await t.get(walletRef);
      const currentBalance = walletSnap.data()?.solde || 0;

      t.set(txRef, {
        uid,
        montant,
        type: 'depot',
        provider: 'paydunya',
        token,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.set(
        walletRef,
        { solde: currentBalance + montant },
        { merge: true }
      );
    });

    return res.status(200).json({ received: true, credited: true });
  } catch (err) {
    console.error('Erreur webhook PayDunya:', err);
    // On répond quand même 200 pour éviter que PayDunya spamme de retries
    // si l'erreur est de notre côté (à ajuster selon tes logs)
    return res.status(200).json({ received: true, error: 'internal_error' });
  }
}
