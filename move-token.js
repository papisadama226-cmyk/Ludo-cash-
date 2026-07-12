// api/move-token.js
// Déplace un pion après un lancer de dé. Le client envoie juste
// "je veux bouger le pion N", le serveur vérifie que c'est légal
// et calcule la nouvelle position. Le client ne peut jamais écrire
// une position directement dans Firestore (règles: allow write: if false).

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

// 57 = position finale (arrivé). -1 = au yard (pas encore sorti).
const FINISH = 57;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    if (!idToken) return res.status(401).json({ error: 'missing_token' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const { gameId, tokenIndex } = req.body;
    if (!gameId || tokenIndex === undefined) {
      return res.status(400).json({ error: 'missing_params' });
    }

    const gameRef = db.collection('games').doc(gameId);

    const result = await db.runTransaction(async (t) => {
      const gameSnap = await t.get(gameRef);
      if (!gameSnap.exists) throw new Error('game_not_found');
      const game = gameSnap.data();

      if (game.currentTurnUid !== uid) throw new Error('not_your_turn');
      if (!game.awaitingMove) throw new Error('no_pending_roll');

      const value = game.lastRoll;
      const tokens = game.tokens || {}; // { uid: [pos0, pos1, pos2, pos3] }
      const myTokens = tokens[uid] || [-1, -1, -1, -1];
      const current = myTokens[tokenIndex];

      if (current === undefined) throw new Error('invalid_token');
      if (current === FINISH) throw new Error('token_already_finished');

      let next;
      if (current === -1) {
        if (value !== 6) throw new Error('need_six_to_exit');
        next = 0; // sort du yard, entre sur la case de départ
      } else {
        next = current + value;
        if (next > FINISH) throw new Error('overshoot'); // il faut le score exact pour finir
      }

      myTokens[tokenIndex] = next;
      tokens[uid] = myTokens;

      // Tour suivant : un 6 permet de rejouer, sinon on passe au joueur suivant
      const players = game.players || [];
      const idx = players.indexOf(uid);
      const nextTurnUid = value === 6 ? uid : players[(idx + 1) % players.length];

      // Victoire : les 4 pions du joueur sont arrivés
      const hasWon = myTokens.every((p) => p === FINISH);

      const update = {
        tokens,
        awaitingMove: false,
        currentTurnUid: nextTurnUid,
      };
      if (hasWon) {
        update.status = 'terminee';
        update.winnerUid = uid;
      }

      t.update(gameRef, update);

      return { newPosition: next, nextTurnUid, hasWon };
    });

    // Si victoire : créditer le pot au gagnant (transaction séparée sur le wallet)
    if (result.hasWon) {
      const gameSnap = await gameRef.get();
      const pot = gameSnap.data().pot || 0;
      const commission = Math.round(pot * 0.05); // 5% de commission
      const gain = pot - commission;

      const walletRef = db.collection('users').doc(uid);
      await db.runTransaction(async (t) => {
        const walletSnap = await t.get(walletRef);
        const solde = walletSnap.data()?.solde || 0;
        t.update(walletRef, { solde: solde + gain });
      });
    }

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('Erreur move-token:', err.message);
    const knownErrors = [
      'not_your_turn', 'no_pending_roll', 'invalid_token',
      'token_already_finished', 'need_six_to_exit', 'overshoot', 'game_not_found',
    ];
    const status = knownErrors.includes(err.message) ? 400 : 500;
    return res.status(status).json({ error: err.message || 'internal_error' });
  }
}
