import { requireUser } from './auth.js';

const GBUX_MINT = '55TpSoMNxbfsNJ9U1dQoo9H3dRtDmjBZVMcKqvU2nray';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const MAX_SINGLE_TRANSFER = 10_000;
const MAX_DAILY_GBUX = 5_000;
const SWAP_FEE_BPS = 30; // 0.30%

const SWAP_PAIRS = {
  gbux_sol: { fromMint: GBUX_MINT, toMint: SOL_MINT, fromSymbol: 'GBUX', toSymbol: 'SOL', rate: 0.00001, min: 10, max: 5000 },
  sol_gbux: { fromMint: SOL_MINT, toMint: GBUX_MINT, fromSymbol: 'SOL', toSymbol: 'GBUX', rate: 100000, min: 0.001, max: 2 },
  gbux_usdc: { fromMint: GBUX_MINT, toMint: USDC_MINT, fromSymbol: 'GBUX', toSymbol: 'USDC', rate: 0.05, min: 10, max: 5000 },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mapReward(row) {
  return {
    id: row.id,
    grudgeId: row.grudge_id,
    rewardType: row.reward_type,
    amount: row.amount,
    sourceGame: row.source_game,
    sourceRef: row.source_ref,
    title: row.title,
    description: row.description,
    itemId: row.item_id,
    nftMint: row.nft_mint,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
  };
}

function mapLedger(row) {
  return {
    id: row.id,
    grudgeId: row.grudge_id,
    walletAddress: row.wallet_address,
    type: row.type,
    amount: row.amount,
    direction: row.direction,
    sourceGame: row.source_game,
    rewardId: row.reward_id,
    txSignature: row.tx_signature,
    memo: row.memo,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function dailyGbuxTotal(env, grudgeId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM gbux_ledger
     WHERE grudge_id = ? AND direction = 'credit' AND status = 'confirmed'
     AND created_at >= datetime('now', '-1 day')`,
  ).bind(grudgeId).first();
  return Number(row?.total ?? 0);
}

async function ledgerBalance(env, grudgeId) {
  const row = await env.DB.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN direction = 'credit' AND status = 'confirmed' THEN amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN direction = 'debit' AND status IN ('confirmed','pending') THEN amount ELSE 0 END), 0)
     AS balance FROM gbux_ledger WHERE grudge_id = ?`,
  ).bind(grudgeId).first();
  return Number(row?.balance ?? 0);
}

async function ensureDailyLoginReward(env, grudgeId) {
  const existing = await env.DB.prepare(
    `SELECT id FROM economy_rewards
     WHERE grudge_id = ? AND reward_type = 'daily_login'
     AND created_at >= datetime('now', 'start of day') LIMIT 1`,
  ).bind(grudgeId).first();
  if (existing) return;

  const amount = 50 + Math.floor(Math.random() * 51);
  await env.DB.prepare(
    `INSERT INTO economy_rewards (grudge_id, reward_type, amount, source_game, title, description, expires_at)
     VALUES (?, 'daily_login', ?, 'forge', 'Daily login bonus', 'Fleet-wide GBUX daily reward', datetime('now', '+7 days'))`,
  ).bind(grudgeId, amount).run();
}

async function proxyGameApi(env, path, init = {}) {
  const base = (env.VPS_AI_AGENT_URL || 'https://api.grudge-studio.com').replace(/\/$/, '');
  const url = `${base}/api/economy${path}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': env.VPS_INTERNAL_KEY || '',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e?.message || String(e) } };
  }
}

export async function handleEconomyRouter(request, env, auth, url, method) {
  const base = '/v1/economy';
  if (!url.pathname.startsWith(base)) return null;

  const userErr = requireUser(auth);
  if (userErr) return json(userErr, 401);

  const grudgeId = url.searchParams.get('grudgeId') || auth.grudgeId;
  if (!grudgeId) return json({ error: 'grudgeId required' }, 400);

  // Economy-specific rate limit (5/min)
  const econKey = `rl:econ:${auth.userId}:${Math.floor(Date.now() / 60000)}`;
  const econCount = parseInt(await env.KV.get(econKey) || '0', 10);
  if (econCount >= 5) {
    return json({ error: 'Economy rate limit exceeded (5/min)', retry_after: 60 }, 429);
  }
  env.KV.put(econKey, String(econCount + 1), { expirationTtl: 120 }).catch(() => {});

  // GET /v1/economy/balance
  if (url.pathname === `${base}/balance` && method === 'GET') {
    const proxied = await proxyGameApi(env, `/balance?grudgeId=${encodeURIComponent(grudgeId)}`);
    if (proxied.ok && (proxied.data.balance != null || proxied.data.gbux != null)) {
      return json({
        balance: Number(proxied.data.balance ?? proxied.data.gbux),
        source: 'game-api',
        grudgeId,
      });
    }
    const balance = await ledgerBalance(env, grudgeId);
    return json({ balance, source: 'hub-ledger', grudgeId });
  }

  // GET /v1/economy/rewards
  if (url.pathname === `${base}/rewards` && method === 'GET') {
    await ensureDailyLoginReward(env, grudgeId);
    const { results } = await env.DB.prepare(
      `SELECT * FROM economy_rewards WHERE grudge_id = ?
       AND status IN ('pending', 'claimed')
       ORDER BY created_at DESC LIMIT 50`,
    ).bind(grudgeId).all();
    return json({ rewards: (results || []).map(mapReward), grudgeId });
  }

  // POST /v1/economy/rewards/claim
  if (url.pathname === `${base}/rewards/claim` && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const rewardId = body.rewardId;
    if (!rewardId) return json({ error: 'rewardId required' }, 400);

    const reward = await env.DB.prepare(
      'SELECT * FROM economy_rewards WHERE id = ? AND grudge_id = ?',
    ).bind(rewardId, grudgeId).first();
    if (!reward) return json({ error: 'Reward not found' }, 404);
    if (reward.status !== 'pending') return json({ error: `Reward already ${reward.status}` }, 400);
    if (reward.expires_at && reward.expires_at < new Date().toISOString()) {
      await env.DB.prepare("UPDATE economy_rewards SET status = 'expired' WHERE id = ?").bind(rewardId).run();
      return json({ error: 'Reward expired' }, 400);
    }

    const daily = await dailyGbuxTotal(env, grudgeId);
    if (daily + reward.amount > MAX_DAILY_GBUX) {
      return json({ error: `Daily GBUX cap (${MAX_DAILY_GBUX}) exceeded` }, 400);
    }
    if (reward.amount > MAX_SINGLE_TRANSFER) {
      return json({ error: `Max single transfer is ${MAX_SINGLE_TRANSFER} GBUX` }, 400);
    }

    const walletAddress = body.walletAddress || null;
    let txSignature = null;
    let transferMsg = 'Credited to hub ledger';

    if (walletAddress) {
      const xfer = await proxyGameApi(env, '/transfer', {
        method: 'POST',
        body: JSON.stringify({
          toAddress: walletAddress,
          amount: reward.amount,
          memo: `reward:${rewardId}`,
          agent: 'hub',
        }),
      });
      if (xfer.ok) {
        txSignature = xfer.data.tx || xfer.data.txSignature || null;
        transferMsg = xfer.data.message || 'On-chain transfer submitted';
      }
    }

    const ledgerId = crypto.randomUUID().replace(/-/g, '');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO gbux_ledger (id, grudge_id, wallet_address, type, amount, direction, source_game, reward_id, tx_signature, memo, status)
         VALUES (?, ?, ?, 'reward', ?, 'credit', ?, ?, ?, ?, ?)`,
      ).bind(
        ledgerId,
        grudgeId,
        walletAddress,
        reward.amount,
        reward.source_game,
        rewardId,
        txSignature,
        `Claimed: ${reward.title}`,
        txSignature ? 'confirmed' : 'confirmed',
      ),
      env.DB.prepare(
        "UPDATE economy_rewards SET status = 'claimed', claimed_at = datetime('now') WHERE id = ?",
      ).bind(rewardId),
    ]);

    return json({ ok: true, message: transferMsg, txSignature, rewardId });
  }

  // POST /v1/economy/rewards/grant (admin)
  if (url.pathname === `${base}/rewards/grant` && method === 'POST') {
    if (auth.scope !== 'admin') return json({ error: 'Admin required' }, 403);
    const body = await request.json().catch(() => ({}));
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SINGLE_TRANSFER) {
      return json({ error: `Invalid amount (max ${MAX_SINGLE_TRANSFER})` }, 400);
    }
    const targetGrudgeId = body.grudgeId || grudgeId;
    const id = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare(
      `INSERT INTO economy_rewards (id, grudge_id, reward_type, amount, source_game, source_ref, title, description, item_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))`,
    ).bind(
      id,
      targetGrudgeId,
      body.rewardType || 'admin',
      amount,
      body.sourceGame || 'forge',
      body.sourceRef || null,
      body.title || 'Admin grant',
      body.description || null,
      body.itemId || null,
    ).run();
    return json({ ok: true, message: 'Reward granted', rewardId: id, id });
  }

  // GET /v1/economy/ledger
  if (url.pathname === `${base}/ledger` && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const { results } = await env.DB.prepare(
      'SELECT * FROM gbux_ledger WHERE grudge_id = ? ORDER BY created_at DESC LIMIT ?',
    ).bind(grudgeId, limit).all();
    return json({ entries: (results || []).map(mapLedger), grudgeId });
  }

  // POST /v1/economy/swap/quote
  if (url.pathname === `${base}/swap/quote` && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const pair = SWAP_PAIRS[body.pairId];
    const fromAmount = Number(body.fromAmount);
    if (!pair) return json({ error: 'Unknown pairId' }, 400);
    if (!Number.isFinite(fromAmount) || fromAmount < pair.min || fromAmount > pair.max) {
      return json({ error: `Amount must be between ${pair.min} and ${pair.max}` }, 400);
    }

    const feeGbux = pair.fromSymbol === 'GBUX' ? (fromAmount * SWAP_FEE_BPS) / 10_000 : 0;
    const netFrom = pair.fromSymbol === 'GBUX' ? fromAmount - feeGbux : fromAmount;
    const toAmount = netFrom * pair.rate;
    const quoteId = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await env.DB.prepare(
      `INSERT INTO economy_swaps (id, grudge_id, pair_id, from_mint, to_mint, from_amount, to_amount, quote_id, fee_gbux, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?)`,
    ).bind(
      quoteId,
      grudgeId,
      body.pairId,
      pair.fromMint,
      pair.toMint,
      fromAmount,
      toAmount,
      quoteId,
      feeGbux,
      expiresAt,
    ).run();

    return json({
      quote: {
        quoteId,
        pairId: body.pairId,
        fromMint: pair.fromMint,
        toMint: pair.toMint,
        fromAmount,
        toAmount,
        rate: pair.rate,
        feeGbux,
        expiresAt,
      },
    });
  }

  // POST /v1/economy/swap/execute
  if (url.pathname === `${base}/swap/execute` && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const quoteId = body.quoteId;
    if (!quoteId) return json({ error: 'quoteId required' }, 400);

    const swap = await env.DB.prepare(
      "SELECT * FROM economy_swaps WHERE quote_id = ? AND grudge_id = ? AND status = 'quoted'",
    ).bind(quoteId, grudgeId).first();
    if (!swap) return json({ error: 'Quote not found or already executed' }, 404);
    if (swap.expires_at && swap.expires_at < new Date().toISOString()) {
      await env.DB.prepare("UPDATE economy_swaps SET status = 'expired' WHERE id = ?").bind(swap.id).run();
      return json({ error: 'Quote expired' }, 400);
    }

    const pair = SWAP_PAIRS[swap.pair_id];
    let txSignature = null;
    // On-chain settlement via game API Jupiter proxy when available
    const swapProxy = await proxyGameApi(env, '/swap/execute', {
      method: 'POST',
      body: JSON.stringify({
        quoteId,
        grudgeId,
        walletAddress: body.walletAddress,
        pairId: swap.pair_id,
        fromAmount: swap.from_amount,
      }),
    });
    if (swapProxy.ok) {
      txSignature = swapProxy.data.txSignature || swapProxy.data.tx || null;
    }

    const ledgerId = crypto.randomUUID().replace(/-/g, '');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO gbux_ledger (id, grudge_id, wallet_address, type, amount, direction, source_game, tx_signature, memo, status)
         VALUES (?, ?, ?, 'swap', ?, 'debit', 'forge', ?, ?, ?)`,
      ).bind(
        ledgerId,
        grudgeId,
        body.walletAddress || null,
        swap.from_amount,
        txSignature,
        `Swap ${pair?.fromSymbol}→${pair?.toSymbol}`,
        txSignature ? 'confirmed' : 'pending',
      ),
      env.DB.prepare(
        "UPDATE economy_swaps SET status = 'executed', tx_signature = ? WHERE id = ?",
      ).bind(txSignature, swap.id),
    ]);

    return json({
      ok: true,
      message: txSignature ? 'Swap executed on-chain' : 'Swap recorded — on-chain settlement pending',
      txSignature,
      toAmount: swap.to_amount,
    });
  }

  // POST /v1/economy/transfer (proxy)
  if (url.pathname === `${base}/transfer` && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SINGLE_TRANSFER) {
      return json({ error: `Invalid amount (max ${MAX_SINGLE_TRANSFER})` }, 400);
    }
    const proxied = await proxyGameApi(env, '/transfer', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!proxied.ok) return json(proxied.data, proxied.status || 502);
    return json(proxied.data);
  }

  // POST /v1/economy/purchase (proxy)
  if (url.pathname === `${base}/purchase` && method === 'POST') {
    const body = await request.text();
    const proxied = await proxyGameApi(env, '/purchase', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!proxied.ok) return json(proxied.data, proxied.status || 502);
    return json(proxied.data);
  }

  return json({ error: 'Economy route not found' }, 404);
}