/**
 * Dual auth: API keys (D1) + Grudge JWT (fleet verify).
 */

export async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPuterToken(token) {
  try {
    const res = await fetch('https://api.puter.com/whoami', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const u = await res.json();
    const uuid = u?.uuid || u?.id;
    if (!uuid) return null;
    const userId = `puter:${uuid}`;
    const h = await sha256(uuid);
    const grudgeId = `grudge-${h.slice(0, 8)}-${Date.now().toString(36)}`;
    return {
      userId,
      grudgeId,
      username: u.username || u.name || null,
      role: 'member',
      isGuest: false,
    };
  } catch (e) {
    console.warn('Puter verify failed:', e?.message || e);
    return null;
  }
}

async function verifyGrudgeJwt(token, env) {
  const verifyUrl = (env.FLEET_VERIFY_URL || 'https://client.grudge-studio.com/api/auth/verify').replace(/\/$/, '');
  try {
    const res = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.valid || !body?.user) return null;
    const u = body.user;
    return {
      userId: String(u.userId || u.id || ''),
      grudgeId: u.grudgeId || null,
      username: u.username || null,
      role: u.role || 'member',
      isGuest: !!u.isGuest,
    };
  } catch (e) {
    console.warn('JWT verify failed:', e?.message || e);
    return null;
  }
}

/** @returns {{ error?: string, keyId?: string, userId?: string, grudgeId?: string, username?: string, scope?: string, tier?: string, rpmLimit?: number, authMode?: string }} */
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();

  if (!bearer) {
    return { error: 'Missing Authorization header (Bearer <api-key> or <grudge-jwt>)' };
  }

  // Grudge JWT (three segments) or Puter session token
  let user = null;
  if (bearer.split('.').length === 3) {
    user = await verifyGrudgeJwt(bearer, env);
  }
  if (!user) {
    user = await verifyPuterToken(bearer);
  }
  if (user?.userId) {
    return {
      authMode: bearer.split('.').length === 3 ? 'jwt' : 'puter',
      userId: user.userId,
      grudgeId: user.grudgeId,
      username: user.username,
      scope: user.role === 'admin' || user.role === 'master' ? 'admin' : 'user',
      tier: 'pro',
      rpmLimit: parseInt(env.RATE_LIMIT_RPM || '60', 10),
      keyId: `user:${user.userId}`,
    };
  }

  const keyHash = await sha256(bearer);
  try {
    const row = await env.DB.prepare(
      'SELECT id, name, scope, tier, rpm_limit, enabled FROM api_keys WHERE key_hash = ?',
    ).bind(keyHash).first();

    if (!row) return { error: 'Invalid API key' };
    if (!row.enabled) return { error: 'API key disabled' };

    env.DB.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?")
      .bind(row.id).run().catch(() => {});

    return {
      authMode: 'apiKey',
      keyId: row.id,
      name: row.name,
      scope: row.scope,
      tier: row.tier,
      rpmLimit: row.rpm_limit,
    };
  } catch (err) {
    const fallbackKey = env.VPS_INTERNAL_KEY;
    if (fallbackKey && bearer === fallbackKey) {
      return { authMode: 'apiKey', keyId: 'env-fallback', name: 'internal', scope: 'admin', tier: 'internal', rpmLimit: 300 };
    }
    return { error: 'Authentication service unavailable' };
  }
}

export function requireUser(auth) {
  if (!auth?.userId) {
    return { error: 'User session required — sign in with Grudge (JWT Bearer token)' };
  }
  return null;
}