# base-lacewing: auth, CSRF and sessions

This repo started from `bevd/base-lacewing` in
[plates](https://github.com/grMLEqomlkkU5Eeinz4brIrOVCUCkJuN/plates). Its auth, CSRF,
gRPC and authorization notes below still apply; the [README](../README.md) covers what the
rest of the suite adds and how to run it.

base-lacewing is
[`bevd/base-jwt`](https://github.com/grMLEqomlkkU5Eeinz4brIrOVCUCkJuN/plates/tree/master/bevd/base-jwt)
(Bun, Elysia, Vue, Drizzle, JWT auth and roles) rebuilt on
[lacewing](https://github.com/Smiduweorc/lacewing), plus double-submit CSRF. The JWT
checks `auth/jwt.ts` used to do by hand are now lacewing's. Opaque refresh tokens and CSRF
are not lacewing's job, so the app does them.

## What lacewing does here

- `auth/jwt.ts`: one verify path, `jwtVerify(token, profile)` against an
  `accessTokenProfile`. `typ: at+jwt` (RFC 9068), pinned issuer and audience, HS256 only,
  a 1h lifetime cap, a unique `jti` on every token. No decode-without-verify, no
  `alg: none`, no HMAC/RSA swap.
- `auth/jwt.ts`: `importKey` entropy-checks `JWT_SECRET`, so `base-jwt`'s old
  `dev-only-secret-...` value is refused. The key is imported on the first sign or verify,
  not at import time, so a weak secret fails there instead of making every module that
  reaches this file need an environment.
- `http/cookies.ts`: token cookies come from `buildTokenCookie`, which always sets
  `HttpOnly; Secure; SameSite`. There is no `COOKIE_SECURE` variable.
- `trpc/context.ts`, `grpc/metadata.ts`: `parseBearer` follows RFC 6750 strictly: exactly
  one `Bearer <token>`, exact-case scheme, no query-string tokens.
- Tests use `unsafeDecode`, which returns an `UntrustedJwt`; the types refuse it wherever
  a `VerifiedJwt` is required.

Refresh tokens are still opaque random strings stored in the database, so the database is
the revocation list and they rotate on every use. lacewing can issue JWT refresh tokens
(`newRefreshToken`, `typ: rt+jwt`, with a revocation store) if you want stateless ones;
the Express lacewing template in plates uses those.

## CSRF: the double submit

`base-jwt` relied on `SameSite=lax` and the CORS allowlist. That breaks if someone relaxes
SameSite, adds a form post, or serves an attacker-controllable subdomain, so this adds a
second check:

- Every session mints a random token (`http/csrf.ts`) into the `csrf_token` cookie. It is
  the one cookie that is not httpOnly, because the page has to read it.
- The Vue tRPC client (`frontend/src/lib/trpc.ts`) sends it back as `x-csrf-token` on
  every call.
- The `csrfGuard` middleware (`trpc/trpc.ts`) rejects any mutation from a caller
  authenticated by cookie unless header and cookie match (timing-safe compare).

A cross-site page can make the browser send our cookies but cannot read them, so it
cannot produce the header. Bearer-authenticated calls are exempt, which is also why gRPC
needs no CSRF handling. `app.test.ts` checks this over real HTTP: same session, same
cookies, no header, 403.

## Sessions

| Token | What it is | Where it lives |
| --- | --- | --- |
| Access | lacewing JWT (`at+jwt`, HS256), 15 minutes, carries `sub`, `email`, `role` | httpOnly cookie |
| Refresh | 32 random bytes, stored as a SHA-256 hash, rotated on use | httpOnly cookie |
| CSRF | 32 random bytes, echoed back as a header | readable cookie |

The Vue app never holds a token.

## Authorization

Unchanged from `base-jwt`: `publicProcedure`, `protectedProcedure` and `adminProcedure`
at the edge, with the real rules in the services (`auth/actor.ts`) because gRPC never
goes through a tRPC procedure. That covers ownership, admin override, draft visibility
(someone else's draft is `NOT_FOUND`, not `FORBIDDEN`), role changes revoking sessions,
and last-admin protection. `base-jwt`'s README has the details.

## gRPC with auth

No cookies and no CSRF. Log in, take the tokens from the response body, and send the
access token as metadata:

```ts
const metadata = new grpc.Metadata();
metadata.set("authorization", `Bearer ${accessToken}`);

client.CreatePost({ title: "Hi", body: "there" }, metadata, callback);
```

The header goes through `parseBearer`: `bearer` (lowercase) or two tokens in one header
resolve to anonymous.

## Tests

On top of what `base-jwt` tests (ownership, escalation attempts, rotation, replay,
self-demotion): the CSRF 403 over real HTTP, the readable versus httpOnly cookie split,
and the claims lacewing requires on every access token (`typ`, `iss`, `aud`, `jti`).

## Not included

- Rate limiting on login. Add it before you ship; brute force is the obvious attack on
  the one endpoint that accepts passwords.
- Email verification and password reset. Both need a mailer, and that is your choice.
- JWKS and asymmetric keys. One service signs and verifies, so an HMAC secret is enough.
  When a second service has to verify these tokens, switch to `generateKeyPair()` (EdDSA)
  and give the profile a `{ jwksUri }`; lacewing handles caching and rotation. With HMAC
  across services every verifier can also mint tokens. If you have to do it anyway,
  [symmetric-jwks.md](https://github.com/grMLEqomlkkU5Eeinz4brIrOVCUCkJuN/plates/blob/master/docs/symmetric-jwks.md)
  in plates covers the safe setups and the one that leaks your signing key.
- `Bun.password`. It is the same argon2id, but Bun-only, and Vitest workers run under
  Node. `@node-rs/argon2` produces the same hash and runs under both.

## Environment

Beyond the base template's variables:

| Variable | Notes |
| --- | --- |
| `JWT_SECRET` | At least 32 characters and entropy-checked. Use `openssl rand -base64 48`. Refuses to boot otherwise. |
| `JWT_ACCESS_EXPIRY` | Required, `15m` in `.env.example`. lacewing's syntax (`30s`, `15m`, `1h`), capped at 1h; anything else refuses to boot. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | Required. Set on and checked against every token. |
| `REFRESH_TOKEN_TTL_DAYS` | Required, `7` in `.env.example`. Refresh tokens are revocable, so this can be long. |
| `COOKIE_SAME_SITE` | `lax` or `strict`. `none` is refused. Every cookie is Secure; `http://localhost` counts as a secure context. |
| `COOKIE_DOMAIN` | See below. |

`COOKIE_DOMAIN` unset leaves every cookie host-only. Set it to the shared parent
(`example.com`) once the Vue app and the API are on different hosts. Script on
`app.example.com` cannot read a `csrf_token` cookie that `api.example.com` scoped to
itself, so without it every mutation fails the CSRF check. A `Domain` cookie goes to every
subdomain, and `csrf_token` is readable by script there too.

`COOKIE_DOMAIN` only covers hosts under one registrable domain. Serving the Vue app from a
different domain than the API would need `SameSite=None`, which this template refuses
because a cross-site token cookie is what CSRF exploits. Put both behind one origin, with
a reverse proxy mounting `/trpc` under the app's domain. `config/env.ts` says so if you
set `COOKIE_SAME_SITE=none`.
