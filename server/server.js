
/* ═══════════════════════════════════════════════════════════
   NARRATIVE MARKET — server.js
   Express backend: narratives CRUD, buy/sell, price history,
   likes, Firebase Firestore, Solana devnet
═══════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const { v4: uuid } = require('uuid');

const {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
  Transaction, SystemProgram
} = require('@solana/web3.js');

const {
  getOrCreateAssociatedTokenAccount, mintTo, createMint,
  getMint, getAccount, TOKEN_PROGRAM_ID,
  createTransferInstruction
} = require('@solana/spl-token');

/* ══ FIREBASE INIT ══ */
const serviceAccount = require('./db.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

/* ══ BS58 compat ══ */
let bs58Encode, bs58Decode;
try {
  const m = require('bs58');
  const i = m.default || m;
  bs58Encode = i.encode;
  bs58Decode = i.decode;
} catch(_) {}

/* ══ CONFIG ══ */
const CFG = {
  PORT:           3001,
  DEVNET_RPC:     'https://api.devnet.solana.com',
  FEE_SOL:        0.007,
  get FEE_LAM()   { return Math.floor(this.FEE_SOL * LAMPORTS_PER_SOL); },
  INITIAL_PRICE:  0.10,   // USD
  SUPPLY:         BigInt(1_000_000_000),
  MM_KEY:         process.env.MM  || '',
  FEE_KEY:        process.env.FEE || '',
};

/* ── In-memory price-walk tracker: { narrativeId: intervalHandle } ── */
const activeWalks = {};

const connection = new Connection(CFG.DEVNET_RPC, 'confirmed');

/* ══ KEYPAIR LOADERS ══ */
function kpFromB58(b58) {
  const sec = bs58Decode ? bs58Decode(b58) : Uint8Array.from(Buffer.from(b58, 'base64'));
  return Keypair.fromSecretKey(sec);
}

const mmWallet  = CFG.MM_KEY  ? kpFromB58(CFG.MM_KEY)  : Keypair.generate();
const feeWallet = CFG.FEE_KEY ? kpFromB58(CFG.FEE_KEY) : Keypair.generate();
console.log(`MM  : ${mmWallet.publicKey}`);
console.log(`Fee : ${feeWallet.publicKey}`);

/* ══════════════════════════════════════════════
   FIREBASE COLLECTIONS
   narratives/{id}     — narrative docs
   narrative_prices/{id}/history — price history subcollection
══════════════════════════════════════════════ */

/* ── Get all narratives ── */
async function getNarratives(marketOnly = false) {
  const snap = await db.collection('narratives').orderBy('createdAt', 'desc').get();
  let narratives = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (marketOnly) narratives = narratives.filter(n => n.inMarket === true);
  
  // Attach active walk info for each narrative
  narratives = narratives.map(n => {
    const walk = activeWalks[n.id];
    if (walk) {
      const elapsed = (Date.now() - walk.startedAt) / 1000;
      const progress = Math.min(100, (elapsed / walk.durationSeconds) * 100);
      n.priceWalk = {
        active: true,
        targetPrice: walk.targetPrice,
        durationSeconds: walk.durationSeconds,
        startedAt: walk.startedAt,
        elapsedSeconds: elapsed,
        progress: progress,
      };
    } else {
      n.priceWalk = { active: false };
    }
    return n;
  });
  
  return narratives;
}

/* ── Get single narrative ── */
async function getNarrative(id) {
  const doc = await db.collection('narratives').doc(id).get();
  if (!doc.exists) return null;
  const n = { id: doc.id, ...doc.data() };
  
  const walk = activeWalks[id];
  if (walk) {
    const elapsed = (Date.now() - walk.startedAt) / 1000;
    const progress = Math.min(100, (elapsed / walk.durationSeconds) * 100);
    n.priceWalk = {
      active: true,
      targetPrice: walk.targetPrice,
      durationSeconds: walk.durationSeconds,
      startedAt: walk.startedAt,
      elapsedSeconds: elapsed,
      progress: progress,
    };
  } else {
    n.priceWalk = { active: false };
  }
  
  return n;
}

/* ── Save narrative ── */
async function createNarrative(data) {
  const id  = uuid();
  const now = Date.now();
  const doc = {
    ...data,
    id,
    createdAt:   now,
    updatedAt:   now,
    likes:       0,
    price:       CFG.INITIAL_PRICE,
    priceChange: 0,
    inMarket:    false,
    holders:     0,
    mintAddress: null,
    migratedAt:  null,
    priceHistory: [{ price: CFG.INITIAL_PRICE, t: now }],
  };
  await db.collection('narratives').doc(id).set(doc);
  return doc;
}

/* ── Like / Unlike ── */
async function updateLikes(id, delta) {
  const ref = db.collection('narratives').doc(id);
  let newLikes = 0;
  await db.runTransaction(async t => {
    const doc = await t.get(ref);
    if (!doc.exists) throw new Error('not found');
    const cur = doc.data().likes || 0;
    newLikes = Math.max(0, cur + delta);
    t.update(ref, { likes: newLikes });
  });
  return newLikes;
}

/* ── Append price history & update price ── */
async function updateNarrativePrice(id, newPrice) {
  const ref = db.collection('narratives').doc(id);
  await db.runTransaction(async t => {
    const doc = await t.get(ref);
    if (!doc.exists) throw new Error('not found');
    const data = doc.data();
    const history = data.priceHistory || [];
    const oldPrice = data.price || CFG.INITIAL_PRICE;
    const change = ((newPrice - oldPrice) / oldPrice) * 100;
    history.push({ price: newPrice, t: Date.now() });
    if (history.length > 200) history.splice(0, history.length - 200);
    t.update(ref, {
      price: newPrice,
      priceChange: parseFloat(change.toFixed(2)),
      priceHistory: history,
      updatedAt: Date.now(),
    });
  });
}

/* ══════════════════════════════════════════════
   GLOBAL SETTINGS — auto-migrate on like threshold
══════════════════════════════════════════════ */
async function getSettings() {
  const doc = await db.collection('settings').doc('global').get();
  return doc.exists ? doc.data() : { autoMigrateEnabled: false, autoMigrateThreshold: 50 };
}

async function setSettings(patch) {
  await db.collection('settings').doc('global').set(patch, { merge: true });
}

/* ── Check if a narrative should auto-migrate to market after a like ── */
async function maybeAutoMigrate(narrativeId) {
  const settings = await getSettings();
  if (!settings.autoMigrateEnabled) return;

  const n = await getNarrative(narrativeId);
  if (!n || n.inMarket) return;

  const threshold = settings.autoMigrateThreshold || 50;
  if ((n.likes || 0) >= threshold) {
    try {
      await mintNarrativeToken(narrativeId);
      // Mark when it was auto-migrated
      await db.collection('narratives').doc(narrativeId).update({
        migratedAt: Date.now()
      });
      console.log(`🚀 auto-migrated narrative ${narrativeId} to market (${n.likes} likes ≥ ${threshold})`);
    } catch (e) {
      console.error(`auto-migrate failed for ${narrativeId}:`, e.message);
    }
  }
}

/* ══════════════════════════════════════════════
   PRICE WALK ENGINE
   Admin sets target price + duration. Server ticks
   every few seconds, nudging price randomly up/down
   but always trending toward target, landing exactly
   on it when time runs out.
══════════════════════════════════════════════ */function startPriceWalk(narrativeId, targetPrice, durationSeconds) {
  stopPriceWalk(narrativeId);

  const tickMs = 3000;
  const totalTicks = Math.max(1, Math.floor((durationSeconds * 1000) / tickMs));
  let ticksElapsed = 0;

  const handle = setInterval(async () => {
    ticksElapsed++;
    try {
      const n = await getNarrative(narrativeId);
      if (!n) { stopPriceWalk(narrativeId); return; }

      const currentPrice = n.price || CFG.INITIAL_PRICE;
      const remainingTicks = totalTicks - ticksElapsed;
      const progress = ticksElapsed / totalTicks;

      let nextPrice;

      if (remainingTicks <= 0) {
        nextPrice = targetPrice;
      } else {
        // --- WILD RANDOM MOVEMENT ---
        
        // Random swing: -40% to +60%
        const swing = (Math.random() * 100) - 40;
        const change = currentPrice * (swing / 100);
        let randomPrice = currentPrice + change;
        
        // Keep within sane bounds
        randomPrice = Math.max(0.0001, randomPrice);
        randomPrice = Math.min(randomPrice, targetPrice * 10);
        
        // As we get closer to the end (last 20% of time)
        // Start guiding toward target but still with randomness
        if (progress > 0.8) {
          const remaining = 1 - progress;
          const distanceToTarget = targetPrice - randomPrice;
          // Stronger guidance as we get closer to the end
          const guidanceFactor = Math.min(1, remaining * 5);
          const guidance = distanceToTarget * guidanceFactor * 0.5;
          const wobble = (Math.random() * 2 - 1) * currentPrice * 0.15;
          nextPrice = randomPrice + guidance + wobble;
        } else {
          // Completely random during the middle
          nextPrice = randomPrice;
        }
        
        // Ensure we don't go too crazy
        nextPrice = Math.max(0.0001, nextPrice);
        nextPrice = Math.min(nextPrice, targetPrice * 10);
      }

      nextPrice = parseFloat(nextPrice.toFixed(6));
      await updateNarrativePrice(narrativeId, nextPrice);

      if (remainingTicks <= 0) {
        stopPriceWalk(narrativeId);
        console.log(`✓ price walk complete for ${narrativeId} → $${targetPrice}`);
      }
    } catch (e) {
      console.error(`price walk tick failed for ${narrativeId}:`, e.message);
    }
  }, tickMs);

  activeWalks[narrativeId] = { 
    handle, 
    targetPrice, 
    durationSeconds, 
    startedAt: Date.now(),
    startPrice: 0
  };
}

function stopPriceWalk(narrativeId) {
  if (activeWalks[narrativeId]) {
    clearInterval(activeWalks[narrativeId].handle);
    delete activeWalks[narrativeId];
  }
}

function getActiveWalk(narrativeId) {
  const w = activeWalks[narrativeId];
  if (!w) return null;
  const elapsed = (Date.now() - w.startedAt) / 1000;
  return {
    targetPrice: w.targetPrice,
    durationSeconds: w.durationSeconds,
    startedAt: w.startedAt,
    elapsedSeconds: elapsed,
    progress: Math.min(100, (elapsed / w.durationSeconds) * 100),
  };
}

/* ── Mint narrative token on devnet ── */
async function mintNarrativeToken(narrativeId) {
  const decimals = 6;
  const supply   = CFG.SUPPLY * BigInt(10 ** decimals);

  const mint  = await createMint(connection, mmWallet, mmWallet.publicKey, mmWallet.publicKey, decimals);
  const mmATA = await getOrCreateAssociatedTokenAccount(connection, mmWallet, mint, mmWallet.publicKey);
  await mintTo(connection, mmWallet, mint, mmATA.address, mmWallet, supply);

  // Save mint to narrative
  await db.collection('narratives').doc(narrativeId).update({
    mintAddress: mint.toString(),
    inMarket:    true,
    updatedAt:   Date.now(),
  });

  return mint.toString();
}

/* ── Buy narrative token ── */
async function buyNarrativeToken(narrativeId, userKeypair, solAmount) {
  const n = await getNarrative(narrativeId);
  if (!n) throw new Error('narrative not found');
  if (!n.mintAddress) throw new Error('narrative not in market');

  const mintPk      = new PublicKey(n.mintAddress);
  const mintInfo    = await getMint(connection, mintPk);
  const price       = n.price || CFG.INITIAL_PRICE;
  // Price in SOL — we need SOL price in USD; use a rough fixed rate or call external API
  // For devnet simplicity: 1 SOL = 1 USD equivalent (configurable)
  const solPriceUSD = parseFloat(process.env.SOL_PRICE_USD || '150');
  const priceSOL    = price / solPriceUSD;
  const tokenAmt    = solAmount / priceSOL;
  const tokenRaw    = BigInt(Math.floor(tokenAmt * (10 ** mintInfo.decimals)));
  if (tokenRaw === 0n) throw new Error('amount too small');

  const mmATA   = await getOrCreateAssociatedTokenAccount(connection, mmWallet, mintPk, mmWallet.publicKey);
  const mmBal   = (await getAccount(connection, mmATA.address)).amount;
  if (BigInt(mmBal) < tokenRaw) throw new Error('liquidity too low');

  const userBal = await connection.getBalance(userKeypair.publicKey);
  const buyLam  = Math.floor(solAmount * LAMPORTS_PER_SOL);
  if (userBal < buyLam + CFG.FEE_LAM + 10000) throw new Error('insufficient SOL');

  const userATA = await getOrCreateAssociatedTokenAccount(connection, mmWallet, mintPk, userKeypair.publicKey);

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: userKeypair.publicKey, toPubkey: mmWallet.publicKey,  lamports: buyLam }),
    SystemProgram.transfer({ fromPubkey: userKeypair.publicKey, toPubkey: feeWallet.publicKey, lamports: CFG.FEE_LAM }),
    createTransferInstruction(mmATA.address, userATA.address, mmWallet.publicKey, tokenRaw, [], TOKEN_PROGRAM_ID)
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer        = userKeypair.publicKey;
  tx.sign(userKeypair, mmWallet);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

  // Bump holders count
  await db.collection('narratives').doc(narrativeId).update({
    holders: admin.firestore.FieldValue.increment(1)
  });

  return { sig, tokenAmount: tokenAmt, solAmount, fee: CFG.FEE_SOL };
}

/* ── Sell narrative token ── */
async function sellNarrativeToken(narrativeId, userKeypair, sellPercent) {
  const n = await getNarrative(narrativeId);
  if (!n?.mintAddress) throw new Error('narrative not in market');

  const mintPk   = new PublicKey(n.mintAddress);
  const mintInfo = await getMint(connection, mintPk);

  const userATA    = await getOrCreateAssociatedTokenAccount(connection, mmWallet, mintPk, userKeypair.publicKey);
  const userBalRaw = BigInt((await getAccount(connection, userATA.address)).amount);
  const userBal    = Number(userBalRaw) / (10 ** mintInfo.decimals);
  if (userBal === 0) throw new Error('no tokens to sell');

  const tokenAmt  = userBal * (sellPercent / 100);
  const tokenRaw  = BigInt(Math.floor(tokenAmt * (10 ** mintInfo.decimals)));
  if (tokenRaw === 0n) throw new Error('sell amount is 0');

  const solPriceUSD = parseFloat(process.env.SOL_PRICE_USD || '150');
  const price       = n.price || CFG.INITIAL_PRICE;
  const priceSOL    = price / solPriceUSD;
  const grossLam    = Math.floor(tokenAmt * priceSOL * LAMPORTS_PER_SOL);
  const netLam      = grossLam - CFG.FEE_LAM;
  if (netLam < 0) throw new Error('fee exceeds trade value');

  const mmATA    = await getOrCreateAssociatedTokenAccount(connection, mmWallet, mintPk, mmWallet.publicKey);
  const mmSolBal = await connection.getBalance(mmWallet.publicKey);
  if (mmSolBal < grossLam) throw new Error('MM SOL reserve low');

  const tx = new Transaction().add(
    createTransferInstruction(userATA.address, mmATA.address, userKeypair.publicKey, tokenRaw, [], TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: mmWallet.publicKey, toPubkey: userKeypair.publicKey, lamports: netLam }),
    SystemProgram.transfer({ fromPubkey: mmWallet.publicKey, toPubkey: feeWallet.publicKey,   lamports: CFG.FEE_LAM })
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer        = userKeypair.publicKey;
  tx.sign(userKeypair, mmWallet);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

  const netSol = netLam / LAMPORTS_PER_SOL;
  return { sig, tokenAmount: tokenAmt, netSol, fee: CFG.FEE_SOL };
}

/* ══════════════════════════════════════════════
   EXPRESS APP
══════════════════════════════════════════════ */
const app = express();
app.use(cors({
  origin: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-admin-key'],
  credentials: true,
}));
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-key');
  res.sendStatus(200);
});
app.use(express.json({ limit: '2mb' }));

/* ── Admin key guard ── */
function isAdmin(req) {
  return req.headers['x-admin-key'] === (process.env.ADMIN_KEY || 'narrative-admin-2024');
}

/* ─── WALLET ROUTES (proxy to Solana) ─── */
app.post('/api/create-wallet', (_, res) => {
  try {
    const kp  = Keypair.generate();
    const pub = kp.publicKey.toString();
    const pri = bs58Encode ? bs58Encode(kp.secretKey) : Buffer.from(kp.secretKey).toString('base64');
    res.json({ publicKey: pub, privateKey: pri });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/import-wallet', (req, res) => {
  try {
    const { privateKey } = req.body;
    if (!privateKey) return res.status(400).json({ error: 'missing privateKey' });
    const kp  = kpFromB58(privateKey);
    res.json({ publicKey: kp.publicKey.toString(), privateKey });
  } catch(e) { res.status(400).json({ error: 'invalid key: ' + e.message }); }
});

app.get('/api/balance/:publicKey', async (req, res) => {
  try {
    const pk     = new PublicKey(req.params.publicKey);
    const lamBal = await connection.getBalance(pk);
    const solBal = lamBal / LAMPORTS_PER_SOL;
    const solPriceUSD = parseFloat(process.env.SOL_PRICE_USD || '150');

    // Pull all narratives that are in market and check user's token balance for each
    const narratives = await getNarratives(true);
    const tokens = [];

    for (const n of narratives) {
      if (!n.mintAddress) continue;
      try {
        const mintPk = new PublicKey(n.mintAddress);
        const ata    = await getOrCreateAssociatedTokenAccount(connection, mmWallet, mintPk, pk);
        const acct   = await getAccount(connection, ata.address);
        const mi     = await getMint(connection, mintPk);
        const balance = Number(acct.amount) / (10 ** mi.decimals);
        if (balance > 0) {
          tokens.push({
            narrativeId: n.id,
            mintAddress: n.mintAddress,
            balance,
            price: n.price || CFG.INITIAL_PRICE,
            priceChange: n.priceChange || 0,
            text: n.text,
            usdValue: balance * (n.price || CFG.INITIAL_PRICE),
          });
        }
      } catch (_) {
        // user has no ATA for this mint yet — skip
      }
    }

    const tokensUsd = tokens.reduce((s, t) => s + t.usdValue, 0);
    res.json({
      solBalance: solBal,
      solPrice: solPriceUSD,
      tokens,
      totalUsdValue: (solBal * solPriceUSD) + tokensUsd,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── NARRATIVE ROUTES ─── */

/* GET /api/narratives?market=true */
app.get('/api/narratives', async (req, res) => {
  try {
    const marketOnly = req.query.market === 'true';
    const narratives = await getNarratives(marketOnly);
    res.json({ narratives });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/narratives/:id */
app.get('/api/narratives/:id', async (req, res) => {
  try {
    const n = await getNarrative(req.params.id);
    if (!n) return res.status(404).json({ error: 'not found' });
    res.json(n);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/narratives — create */
app.post('/api/narratives', async (req, res) => {
  try {
    const { text, authorKey } = req.body;
    if (!text || !authorKey) return res.status(400).json({ error: 'missing text or authorKey' });
    const words = text.trim().split(/\s+/).length;
    if (words < 30) return res.status(400).json({ error: 'minimum 30 words required' });
    const profile = await getProfile(authorKey);
    const n = await createNarrative({
      text: text.trim(),
      authorKey,
      authorName: profile?.name || '',
      authorPic:  profile?.pic  || '',
    });
    res.json(n);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── PROFILE ROUTES ── */
async function getProfile(pubkey) {
  const doc = await db.collection('profiles').doc(pubkey).get();
  return doc.exists ? doc.data() : null;
}

/* GET /api/profile/:pubkey */
app.get('/api/profile/:pubkey', async (req, res) => {
  try {
    const profile = await getProfile(req.params.pubkey);
    res.json({ profile: profile || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/profile — create/update {pubkey, name, pic} */
app.post('/api/profile', async (req, res) => {
  try {
    const { pubkey, name, pic } = req.body;
    if (!pubkey) return res.status(400).json({ error: 'missing pubkey' });
    if (pic && pic.length > 500000) {
      return res.status(400).json({ error: 'image too large — please use a smaller photo' });
    }
    const profile = {
      name: (name || '').trim().slice(0, 20),
      pic:  pic || '',
      updatedAt: Date.now(),
    };
    await db.collection('profiles').doc(pubkey).set(profile, { merge: true });

    // Backfill author info on this user's existing narratives so feed/market stay in sync
    const snap = await db.collection('narratives').where('authorKey', '==', pubkey).get();
    const batch = db.batch();
    snap.docs.forEach(d => {
      batch.update(d.ref, { authorName: profile.name, authorPic: profile.pic });
    });
    if (!snap.empty) await batch.commit();

    res.json({ ok: true, profile });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/narratives/:id/like */
app.post('/api/narratives/:id/like', async (req, res) => {
  try {
    const { delta } = req.body;
    const newLikes = await updateLikes(req.params.id, delta || 1);

    // Only check migration on upvotes, not unlikes
    if ((delta || 1) > 0) {
      // Check if we should auto-migrate
      const settings = await getSettings();
      if (settings.autoMigrateEnabled && newLikes >= (settings.autoMigrateThreshold || 50)) {
        const n = await getNarrative(req.params.id);
        if (n && !n.inMarket) {
          try {
            await mintNarrativeToken(req.params.id);
            await db.collection('narratives').doc(req.params.id).update({
              migratedAt: Date.now()
            });
            console.log(`🚀 auto-migrated narrative ${req.params.id} (${newLikes} likes)`);
            // Return migration status in response
            return res.json({ ok: true, migrated: true, likes: newLikes });
          } catch (e) {
            console.error(`auto-migrate failed for ${req.params.id}:`, e.message);
          }
        }
      }
    }

    res.json({ ok: true, likes: newLikes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/narratives/:id/mint  [admin] — list narrative on market */
app.post('/api/narratives/:id/mint', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
  try {
    const mintAddress = await mintNarrativeToken(req.params.id);
    await db.collection('narratives').doc(req.params.id).update({
      migratedAt: req.body.auto ? Date.now() : null
    });
    res.json({ ok: true, mintAddress });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/narratives/:id/price  [admin] — update price
   Body: { price }                              → instant update (old behavior)
   Body: { targetPrice, durationSeconds }        → timed random walk to target */
app.post('/api/narratives/:id/price', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
  try {
    const { price, targetPrice, durationSeconds } = req.body;

    if (targetPrice !== undefined && durationSeconds !== undefined) {
      const tp = parseFloat(targetPrice);
      const dur = parseInt(durationSeconds);
      if (!tp || tp <= 0) return res.status(400).json({ error: 'invalid targetPrice' });
      if (!dur || dur <= 0) return res.status(400).json({ error: 'invalid durationSeconds' });

      startPriceWalk(req.params.id, tp, dur);
      return res.json({ ok: true, walking: true, targetPrice: tp, durationSeconds: dur });
    }

    if (!price || isNaN(price)) return res.status(400).json({ error: 'invalid price' });
    stopPriceWalk(req.params.id); // instant set cancels any running walk
    await updateNarrativePrice(req.params.id, parseFloat(price));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/narratives/:id/price/stop  [admin] — cancel an active price walk */
app.post('/api/narratives/:id/price/stop', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
  stopPriceWalk(req.params.id);
  res.json({ ok: true, stopped: true });
});

/* GET /api/narratives/:id/price/walk  [admin] — check active walk status */
app.get('/api/narratives/:id/price/walk', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
  res.json({ walk: getActiveWalk(req.params.id) });
});

/* ── GLOBAL SETTINGS [admin] ── */
app.get('/api/admin/settings', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/settings', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
  try {
    const { autoMigrateEnabled, autoMigrateThreshold } = req.body;
    const patch = {};
    if (autoMigrateEnabled !== undefined) patch.autoMigrateEnabled = !!autoMigrateEnabled;
    if (autoMigrateThreshold !== undefined) {
      const t = parseInt(autoMigrateThreshold);
      if (!t || t <= 0) return res.status(400).json({ error: 'invalid threshold' });
      patch.autoMigrateThreshold = t;
    }
    await setSettings(patch);
    const settings = await getSettings();
    res.json({ ok: true, settings });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/narratives/:id/buy */
app.post('/api/narratives/:id/buy', async (req, res) => {
  try {
    const { privateKey, solAmount } = req.body;
    if (!privateKey || !solAmount) return res.status(400).json({ error: 'missing params' });
    const userKp = kpFromB58(privateKey);
    const result = await buyNarrativeToken(req.params.id, userKp, parseFloat(solAmount));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/narratives/:id/sell */
app.post('/api/narratives/:id/sell', async (req, res) => {
  try {
    const { privateKey, sellPercent } = req.body;
    if (!privateKey || !sellPercent) return res.status(400).json({ error: 'missing params' });
    const userKp = kpFromB58(privateKey);
    const result = await sellNarrativeToken(req.params.id, userKp, parseFloat(sellPercent));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/narratives/:id/price-history */
app.get('/api/narratives/:id/price-history', async (req, res) => {
  try {
    const n = await getNarrative(req.params.id);
    if (!n) return res.status(404).json({ error: 'not found' });
    res.json({ history: n.priceHistory || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── ADMIN: list all for admin panel ─── */
app.get('/api/admin/narratives', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
  try {
    const narratives = await getNarratives();
    res.json({ narratives });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(CFG.PORT, () => {
  console.log(`\n🖊  Narrative Market server → http://localhost:${CFG.PORT}`);
  console.log(`   MM  wallet : ${mmWallet.publicKey}`);
  console.log(`   Fee wallet : ${feeWallet.publicKey}\n`);
});