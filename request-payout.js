// api/request-payout.js
// Au lancement, on garde une validation MANUELLE des retraits (toi qui approuves)
// pour éviter tout abus le temps de roder le système.
// Plus tard, tu pourras brancher l'API "Payouts" de PayDunya pour automatiser.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
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
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    if (!idToken) return res.status(401).json({ error: 'missing_token' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const { montant, numeroWave } = req.body;
    if (!montant || montant <= 0 || !numeroWave) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const walletRef = db.collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const walletSnap = await t.get(walletRef);
      const solde = walletSnap.data()?.solde || 0;

      if (solde < montant) {
        throw new Error('solde_insuffisant');
      }

      // On bloque immédiatement les fonds (évite double demande)
      t.update(walletRef, { solde: solde - montant });

      const payoutRef = db.collection('payouts').doc();
      t.set(payoutRef, {
        uid,
        montant,
        numeroWave,
        status: 'en_attente', // toi tu passes à "paye" ou "refuse" depuis un dashboard/Firestore console
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.status(200).json({ success: true, message: 'Demande de retrait enregistrée' });
  } catch (err) {
    console.error('Erreur request-payout:', err.message);
    const status = err.message === 'solde_insuffisant' ? 400 : 500;
    return res.status(status).json({ error: err.message || 'internal_error' });
  }
}
