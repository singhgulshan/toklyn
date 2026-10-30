// Timestamps are epoch-ms strings; '' stands for null. Claims and metadata are opaque JSON
// strings, never decoded here, because cjson turns empty arrays into objects.

/** KEYS: session, token, subject. ARGV: session fields, token fields, ttl. */
export const CREATE_SESSION = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local ttl = tonumber(ARGV[12])
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'subject', ARGV[2], 'claims', ARGV[3],
  'metadata', ARGV[4], 'createdAt', ARGV[5], 'expiresAt', ARGV[6], 'revokedAt', ARGV[7])
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('HSET', KEYS[2], 'sessionId', ARGV[8], 'issuedAt', ARGV[9],
  'expiresAt', ARGV[10], 'consumedAt', ARGV[11])
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('SADD', KEYS[3], ARGV[1])
if redis.call('PTTL', KEYS[3]) < ttl then
  redis.call('PEXPIRE', KEYS[3], ttl)
end
return 1
`;

/** KEYS: session. */
export const FIND_SESSION = `
return redis.call('HGETALL', KEYS[1])
`;

/**
 * KEYS: presented token, new token.
 * ARGV: key prefix, now, refreshTtlMs, reuseGraceMs, has claims ('1'/'0'), claims.
 */
export const ROTATE = `
local sid = redis.call('HGET', KEYS[1], 'sessionId')
if not sid then return {'unknown_token'} end
local skey = ARGV[1] .. 's:' .. sid
if redis.call('EXISTS', skey) == 0 then return {'unknown_token'} end

local now = tonumber(ARGV[2])
local s = redis.call('HMGET', skey, 'expiresAt', 'revokedAt')
local sessionExpiresAt = tonumber(s[1])
if s[2] ~= '' then return {'session_revoked', redis.call('HGETALL', skey)} end
if now >= sessionExpiresAt then
  return {'session_expired', redis.call('HGETALL', skey)}
end

local t = redis.call('HMGET', KEYS[1], 'expiresAt', 'consumedAt')
if t[2] ~= '' then
  local grace = tonumber(ARGV[4])
  if grace <= 0 or now - tonumber(t[2]) > grace then
    redis.call('HSET', skey, 'revokedAt', ARGV[2])
    return {'reuse_detected', redis.call('HGETALL', skey)}
  end
end
if now >= tonumber(t[1]) then return {'token_expired'} end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return redis.error_reply('toklyn: refresh token hash already exists')
end

if t[2] == '' then redis.call('HSET', KEYS[1], 'consumedAt', ARGV[2]) end
if ARGV[5] == '1' then redis.call('HSET', skey, 'claims', ARGV[6]) end
local expiresAt = string.format('%.0f',
  math.min(now + tonumber(ARGV[3]), sessionExpiresAt))
redis.call('HSET', KEYS[2], 'sessionId', sid, 'issuedAt', ARGV[2],
  'expiresAt', expiresAt, 'consumedAt', '')
local ttl = redis.call('PTTL', skey)
if ttl > 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
return {'rotated', redis.call('HGETALL', skey), expiresAt}
`;

/** KEYS: session. ARGV: now. */
export const REVOKE_SESSION = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
if redis.call('HGET', KEYS[1], 'revokedAt') == '' then
  redis.call('HSET', KEYS[1], 'revokedAt', ARGV[1])
end
return redis.call('HGETALL', KEYS[1])
`;

/** KEYS: subject. ARGV: key prefix, now, revoke ('1'/'0'). Drops ids of evicted sessions. */
export const ACTIVE_FOR_SUBJECT = `
local now = tonumber(ARGV[2])
local out = {}
for _, sid in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local skey = ARGV[1] .. 's:' .. sid
  local s = redis.call('HMGET', skey, 'expiresAt', 'revokedAt')
  if not s[1] then
    redis.call('SREM', KEYS[1], sid)
  elseif s[2] == '' and tonumber(s[1]) > now then
    if ARGV[3] == '1' then redis.call('HSET', skey, 'revokedAt', ARGV[2]) end
    out[#out + 1] = redis.call('HGETALL', skey)
  end
end
return out
`;

/** KEYS: revocation entry. ARGV: expiresAt, ttl. Keeps the later expiry. */
export const REVOKE_ACCESS_TOKEN = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
end
return 1
`;

/** KEYS: revocation entry. */
export const GET_ACCESS_TOKEN_REVOCATION = `
return redis.call('GET', KEYS[1])
`;
