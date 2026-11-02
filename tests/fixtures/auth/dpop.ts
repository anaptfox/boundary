import { createHash, createPublicKey, verify } from "node:crypto";
import { verifyBearerToken, type OAuthTokenVerifier, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
const headerSchema = z.object({ typ: z.literal("dpop+jwt"), alg: z.literal("ES256"), jwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string() }).strict() }).strict();
const payloadSchema = z.object({ jti: z.string().min(1).max(128), htm: z.string(), htu: z.string(), iat: z.number().int(), ath: z.string() }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

/** Bounded local proof fixture, not an OAuth authorization server or production verifier. */
export function localDpopGate({ verifier, resource, tokenThumbprint }: { verifier: OAuthTokenVerifier; resource: URL; tokenThumbprint: string }) {
  const seen = new Map<string, number>();
  return async (request: Request): Promise<AuthInfo | Response> => {
    try {
      const token = request.headers.get("authorization")?.match(/^DPoP ([^\s]+)$/u)?.[1];
      const proof = request.headers.get("dpop");
      if (!token || !proof || proof.length > 4096) throw new Error("proof required");
      const auth = await verifyBearerToken(`Bearer ${token}`, { verifier, expectedResource: resource, requiredScopes: ["folio:read"] });
      const parts = proof.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error("invalid proof");
      const header = headerSchema.parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString()));
      const payload = payloadSchema.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString()));
      const { crv, kty, x, y } = header.jwk;
      if (hash(JSON.stringify({ crv, kty, x, y })) !== tokenThumbprint) throw new Error("key not bound to token");
      const url = new URL(request.url); url.search = ""; url.hash = "";
      const now = Math.floor(Date.now() / 1000);
      if (payload.htm !== request.method || payload.htu !== url.href || payload.ath !== hash(token) || payload.iat < now - 60 || payload.iat > now + 5) throw new Error("proof claims do not match request");
      const signature = Buffer.from(parts[2]!, "base64url");
      if (signature.length !== 64 || !verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature)) throw new Error("invalid signature");
      for (const [id, expiry] of seen) if (expiry < now) seen.delete(id);
      if (seen.has(payload.jti) || seen.size >= 1024) throw new Error("replayed proof or full replay cache");
      seen.set(payload.jti, payload.iat + 60);
      return auth;
    } catch { return Response.json({ error: "invalid_token" }, { status: 401, headers: { "www-authenticate": 'DPoP error="invalid_token"' } }); }
  };
}
