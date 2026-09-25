import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Anonymous install tokens: no account, but every client has to fetch a
// server-signed ID first. Registration is rate limited per IP, so rotating
// IDs to dodge the per-install quota doesn't get anyone very far.

const VERSION = "v1";

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueToken(secret, nowMs = Date.now()) {
  const installId = randomUUID();
  const payload = `${VERSION}.${installId}.${Math.floor(nowMs / 1000)}`;
  return { installId, token: `${payload}.${sign(payload, secret)}` };
}

/** @returns {string | null} the install ID if the token is authentic */
export function verifyToken(token, secret) {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(parts[3]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return parts[1];
}
