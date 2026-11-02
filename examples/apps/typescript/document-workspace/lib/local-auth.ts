import { OAuthError, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";

/** Local introspection fixture. Replace this object with the host's real verifier. */
export function localTokenVerifier(resource: URL): OAuthTokenVerifier {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const claims = new Map<string, AuthInfo>([
    ["folio-local-read", { token: "folio-local-read", clientId: "folio-scout", scopes: ["folio:read"], expiresAt, resource, extra: { workspace: "folio" } }],
    ["folio-local-draft", { token: "folio-local-draft", clientId: "folio-editor", scopes: ["folio:read", "folio:draft"], expiresAt, resource, extra: { workspace: "folio" } }],
    ["folio-local-foreign", { token: "folio-local-foreign", clientId: "folio-foreign", scopes: ["folio:read", "folio:draft"], expiresAt, resource, extra: { workspace: "other" } }],
  ]);
  return {
    async verifyAccessToken(token) {
      const info = claims.get(token);
      if (!info) throw new OAuthError("invalid_token", "Unknown local credential");
      return { ...info, scopes: [...info.scopes], resource: new URL(resource), extra: { ...info.extra } };
    },
  };
}
