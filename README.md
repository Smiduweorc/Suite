# Suite

An example backend (Bun + Elysia), web client (Vue) and mobile app (Expo) that use the
[Smiduweorc](https://github.com/Smiduweorc) libraries together.

| Library | What it does here | Where |
| --- | --- | --- |
| [lacewing](https://github.com/Smiduweorc/lacewing) | Verifies access tokens, cookies and `Bearer` headers | backend |
| [phasmid](https://github.com/Smiduweorc/phasmid) | Canonical email addresses | backend (account identity), web and mobile (live preview) |
| [Repletes](https://github.com/Smiduweorc/Repletes) | Caches the public feed in Redis | backend |
| [firefly](https://github.com/Smiduweorc/firefly) | Deadlines, retries and a breaker | backend (around Postgres), mobile (around the API) |
| [mycocepurus-smithii](https://github.com/Smiduweorc/mycocepurus-smithii) | `Idempotency-Key` on `POST /api/v1/posts`, in Redis | backend |
| [dung beetle](https://github.com/Smiduweorc/dung-beetle-template) / [Aphid](https://github.com/Smiduweorc/Aphid-template) | Generates the typed API client from the backend's OpenAPI | `api-client/` |
| [Cephalote](https://github.com/Smiduweorc/Cephalote) | Scans for weak crypto | CI |

antlion (DPoP for lacewing) is optional and not used here.

## Run it

Needs Bun and Docker. Run `bun install`, copy each `.env.example` to `.env` in
`frontend/`, `mobile/` and `backend/`, and set `JWT_SECRET` in `backend/.env` with
`openssl rand -base64 48`. lacewing entropy-checks it, so a passphrase you typed yourself
refuses to boot. Then `bun run db:up` (Postgres 17 and Redis 8), `bun run db:migrate`,
`bun run db:seed`, and `bun run dev`. The seed creates `alice@example.com` (admin) and
`bob@example.com`, both with password `password123`. `bun run mobile` starts the Expo dev
server.

`db:up` binds 5432 and 6379 on loopback only. If something else already listens there,
change the host port (the middle number in `ports:`) in `docker-compose.yml` and the
matching URLs in `backend/.env`.

Use `db:migrate`, not `db:push`, on a database that already has users:
`0001_canonical_email_key` backfills the new column, and `push` refuses to add a
`NOT NULL` column to a non-empty table.

## Email addresses (phasmid)

`users.email_key` is the unique column, not `users.email`. It holds the canonical mailbox
(`backend/src/auth/email.ts`): `John.Doe+news@googlemail.com` and `johndoe@gmail.com`
reach one Gmail inbox, so registering the second is a `CONFLICT`, and either one signs in.
Unknown domains keep phasmid's default (`a+b@example.com` might be another mailbox),
except that local parts are case-insensitive, as this app always treated them.

The web form and the mobile login screen show the canonical address as you type. The web
app imports the server's function (`@bevd/backend/email`) and the mobile app calls phasmid
directly; it is pure ESM, so the same code runs in Bun, the browser and Hermes.

## Feed cache (Repletes, firefly)

`GET /api/v1/feed` and `trpc.post.feed` serve published posts from one cache key, and
every response says where it came from:

| `cache.state` | Meaning |
| --- | --- |
| `miss` | just queried Postgres |
| `fresh` | from Redis, under 10s old |
| `stale` | from Redis, under 70s old; one background refresh is running |
| `retained` | Postgres failed, so this is the last good copy, up to 10 minutes old |

Order, outside in: Repletes, firefly, the query (`backend/src/suite/index.ts`). A cache
hit skips the breaker. A miss gets a 2s deadline and one retry, only when Postgres was
unreachable (a failing query fails the same way twice). Five consecutive failures open the
breaker for 15s; while it is open, stale-if-error serves the retained copy, or a 503 if
there is none. `/health` reports firefly's view of Postgres. Publishing, editing or
deleting a published post clears the key.

## Idempotent posts (mycocepurus-smithii, firefly)

`POST /api/v1/posts` requires an `Idempotency-Key` (an RFC 8941 String, so the value is
quoted). Per the IETF draft:

- The first request runs. Every retry with the same key gets the first response back byte
  for byte, with `idempotent-replayed: true`.
- The same key with a different body is `422`, a concurrent duplicate is `409`, and a
  missing key is `400`.
- Keys are scoped to the user, so nobody can replay someone else's response.

The claim is one atomic `SET NX PX` in Redis, so it holds across replicas. With Redis
down, the write is refused with a 503.

To see it on the phone: open Compose, turn on "Lose the first response", and publish. The
reply is thrown away as if the connection dropped, firefly retries with the same key, and
the card comes back marked replayed. One post is created.

## Generated API client (dung beetle)

`api-client/` is the dung beetle template's runtime and generator, pointed at the
backend's own OpenAPI document. `bun run client:generate` regenerates it and prints the
public names it added and removed. Retries go in the transport, which is firefly's
(`mobile/src/transport.ts`).

That file is the one workaround in this suite. firefly's stock `transport()` replays a
body by reading `request.body` as a stream, but React Native's `Request` polyfill has no
body stream and marks the original as used on copy. The mobile transport reads the body
once and rebuilds the request per attempt, using firefly's own predicates and status
lists.

## Tokens (lacewing)

As in the template this repo started from, plus access-token revocation: `at+jwt` access
tokens with pinned issuer and audience and an entropy-checked secret, opaque rotating
refresh tokens, and double-submit CSRF for the cookie-based web app. The mobile app gets
tokens in the response body, keeps them in the device keychain (`expo-secure-store`), and
sends them as `Bearer`, which lacewing's `parseBearer` checks against RFC 6750. Details
are in [docs/base-lacewing.md](docs/base-lacewing.md).

Signing out on the phone revokes the refresh token at `POST /api/v1/auth/logout`, then
deletes the session from the keychain. The route takes only the refresh token, so an
expired access token (`JWT_ACCESS_EXPIRY`, 15 minutes in `.env.example`) cannot block
sign-out. If the server can't be reached within firefly's 8s deadline, the phone signs out
anyway and says so; the refresh token then stays valid on the server until
`REFRESH_TOKEN_TTL_DAYS` runs out.

Access tokens are revocable through lacewing's `RevocationStore`. Each carries its session
as `sid` (`refresh_tokens.session_id`, kept across rotations), and the backend accepts it
only while that session still has a live refresh token. Sign-out, a role change and
refresh-token expiry end the access tokens on the next request. The cost is one indexed
lookup per authenticated request, and with Postgres down every caller is treated as signed
out.

## Crypto scanning (Cephalote)

CI's `crypto-scan` job downloads a pinned Cephalote release, verifies its checksum, and
fails on any finding. Locally: `cephalote scan .` (it's in the AUR as `cephalote`).

## Layout

| Path | What it is |
| --- | --- |
| `backend/` | Bun + Elysia: REST `/api/v1` (mobile), tRPC `/trpc` (web), gRPC `:50051`, OpenAPI `/openapi` |
| `backend/src/suite/` | All the Smiduweorc library settings in one file, plus the Redis stores |
| `frontend/` | Vue 3 + tRPC, with the phasmid preview and the cached feed panel |
| `api-client/` | `@suite/api-client`, generated by dung beetle; `openapi.json` is committed |
| `mobile/` | Expo SDK 57 (React Native 0.86): sign in, feed, idempotent compose |

## Tests

The unit tests need no Docker. The backend runs against PGlite and the libraries'
`MemoryStore`s; the Redis adapters are tested against `ioredis-mock` through the real
`Cache` and `Ledger` classes. The tests run on Node (Vitest's runner) whichever command
starts them.

PGlite runs one transaction at a time, so a few things only show up on real servers: two
refreshes racing on one token, Postgres cancelling a query at `statement_timeout`, and
`SET NX` holding across connections. Those are in `backend/src/__integration__/`:

```sh
bun run db:up
INTEGRATION_DATABASE_URL=postgres://bevd:bevd@localhost:5432/bevd \
INTEGRATION_REDIS_URL=redis://localhost:6379 \
bun run test:integration   # about 6s, 5 of them waiting on statement_timeout
```

Each run creates its own database, migrates it from `backend/drizzle` and drops it
afterwards; in Redis it writes under its own key prefix and deletes only that. With a URL
unset, the tests that need it are skipped, and under CI that is an error. CI runs them
against Postgres 17 and Redis 8, and also builds the backend image, checks it contains no
`.env`, tests or `.git` and does not run as root, then boots it and calls `/health`.

## Environment

On top of the template's variables ([docs/base-lacewing.md](docs/base-lacewing.md#environment)):

| Variable | Where | Notes |
| --- | --- | --- |
| `REDIS_URL` | backend | Feed cache and idempotency ledger. Not awaited at boot, so an outage degrades the app instead of blocking it. |
| `EXPO_PUBLIC_API_URL` | mobile | `localhost` on an iOS simulator, `10.0.2.2` on an Android emulator, your LAN IP on a phone. |
