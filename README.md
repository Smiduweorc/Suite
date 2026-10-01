# Suite

An example backend, web client and mobile app that use the
[Smiduweorc](https://github.com/Smiduweorc) libraries together, as one suite, instead of
one at a time. Each library answers one question, and the app is arranged so you can see
where each answer comes from:

| Library | The question it answers | Where it runs here |
| --- | --- | --- |
| [lacewing](https://github.com/Smiduweorc/lacewing) | Is this token what it claims to be? | backend: every access token, cookie and `Bearer` header |
| [phasmid](https://github.com/Smiduweorc/phasmid) | Which mailbox does this address reach? | backend (account identity), web and mobile (live preview) |
| [Repletes](https://github.com/Smiduweorc/Repletes) | Do I need to compute this again? | backend: the public feed, in Redis |
| [firefly](https://github.com/Smiduweorc/firefly) | What do I do about a failed call? | backend (around Postgres), mobile (around the API) |
| [mycocepurus-smithii](https://github.com/Smiduweorc/mycocepurus-smithii) | Has this request already happened? | backend: `Idempotency-Key` on `POST /api/v1/posts`, in Redis |
| [dung beetle](https://github.com/Smiduweorc/dung-beetle-template) / [Aphid](https://github.com/Smiduweorc/Aphid-template) | What is this API, and what happened? | `api-client/`, generated from the backend's own OpenAPI |
| [Cephalote](https://github.com/Smiduweorc/Cephalote) | Is there weak crypto in this tree? | CI |

(antlion, DPoP for lacewing, is optional and deliberately left out.)

```
 web (Vue) ----------------- tRPC, cookies + CSRF -----------------+
                                                                    |
                                                                    v
 mobile (Expo) -- @suite/api-client -- firefly -- REST /api/v1 --> backend (Bun + Elysia)
   phasmid        (dung beetle)        retries    Bearer,             lacewing, phasmid
                                                  Idempotency-Key     |
                                                                      |
                       Repletes (feed) --> firefly (postgres) --> Postgres
                       mycocepurus (ledger) --------------------> Redis
```

## Run it

```sh
bun install
cp frontend/.env.example frontend/.env
cp mobile/.env.example mobile/.env
cp backend/.env.example backend/.env
# then set JWT_SECRET in backend/.env:  openssl rand -base64 48
# (lacewing entropy-checks it - a human-chosen passphrase refuses to boot)

bun run db:up        # Postgres 17 + Redis 8 (docker compose)
bun run db:migrate
bun run db:seed      # alice@example.com (admin), bob@example.com - both password123

bun run dev          # backend :3000 (REST, tRPC, /openapi) + gRPC :50051 + web :5173
bun run mobile       # Expo dev server - scan the QR code with Expo Go, or press a / i
```

`db:up` binds 5432 and 6379 on the host's loopback interface only. If something else
already listens there, change the host port (the middle number in `ports:`) in
`docker-compose.yml` and the matching URLs in `backend/.env`.

Use `db:migrate` rather than `db:push` on a database that already has users:
`0001_canonical_email_key` backfills the new column, where `push` would refuse to add a
`NOT NULL` column to a non-empty table.

## A tour

### One mailbox, one account (phasmid)

`users.email_key` is the unique column, not `users.email`. It holds the canonical mailbox
(`backend/src/auth/email.ts`): `John.Doe+news@googlemail.com` and `johndoe@gmail.com`
both reach one Gmail inbox, so registering the second is a `CONFLICT`, and either one
signs in. Unknown domains keep phasmid's conservative default (`a+b@example.com` might be
another mailbox), with one opt-in: local parts are case-insensitive, as this app always
treated them.

The web form and the mobile login screen show the canonical address as you type. The web
app imports the server's own function (`@bevd/backend/email`), and the mobile app calls
phasmid directly. It is pure ESM, so the same code runs in Bun, the browser and Hermes.

### A feed that survives its database (Repletes + firefly)

`GET /api/v1/feed` and `trpc.post.feed` serve published posts from one cache key, and
every response says where it came from:

| `cache.state` | Meaning |
| --- | --- |
| `miss` | just queried Postgres |
| `fresh` | from Redis, under 10s old |
| `stale` | from Redis, under 70s old; one background refresh is running behind it |
| `retained` | Postgres failed, so this is the last good copy, up to 10 minutes old |

The layers nest in the order both libraries ask for (`backend/src/suite/index.ts`):
Repletes outside, then firefly, then the query. A cache hit never touches the breaker. A
miss goes through a 2s deadline, and gets one retry only if Postgres was unreachable (a
failing query fails the same way twice). Five consecutive failed attempts open the breaker
for 15s, and while it's open Repletes' stale-if-error serves what it retained. With nothing
retained, the answer is a 503, not a 500, because an outage isn't a bug. `/health` reports firefly's view of Postgres. Publishing,
editing or deleting a published post clears the key.

### Exactly-once writes from a flaky phone (mycocepurus-smithii + firefly)

`POST /api/v1/posts` requires an `Idempotency-Key` (an RFC 8941 String, so the value is
quoted). Per the IETF draft:

- The first request runs, and every retry with the same key gets the first response back
  byte for byte, with `idempotent-replayed: true`.
- The same key with a different body is `422`, a concurrent duplicate is `409`, and a
  missing key is `400`.
- Keys are scoped to the user, so nobody can replay someone else's response by guessing.

The claim is one atomic `SET NX PX` in Redis, so this also holds across replicas. With
Redis down, the write is refused with a 503 rather than performed without the guarantee.

On the phone, open **Compose**, turn on *Lose the first response*, and publish. The post is
created, the reply is thrown away as if the connection dropped, firefly retries with the
same key, and the card comes back marked **replayed**: one post, not two.

### A client nobody wrote by hand (dung beetle)

`api-client/` is the dung beetle template's runtime plus its generator, pointed at the
backend's own OpenAPI document:

```sh
bun run client:generate   # backend -> api-client/openapi.json -> src/resources -> dist
```

The generator prints the public names it added and removed, so an API change shows up in
review. The client describes the API and reports what happened. Retries are plugged in
through its one seam, the transport, which is firefly's (`mobile/src/transport.ts`).

That file is also the one place this suite needed a workaround. firefly's stock
`transport()` replays a body by reading `request.body` as a stream, but React Native's
`Request` polyfill has no body stream and marks the original as used on copy. The mobile
transport reads the body once and rebuilds the request per attempt, using firefly's own
predicates and status lists. It has its own tests (`bun run --cwd mobile test`).

### Tokens (lacewing)

As in the template this repo started as, plus access-token revocation (below): `at+jwt`
access tokens with pinned issuer and audience and an entropy-checked secret, opaque
rotating refresh tokens, and double-submit CSRF for the cookie-based web app. The mobile app uses the other door: tokens
in the response body, kept in the device keychain (`expo-secure-store`), and sent as
`Bearer`, which lacewing's `parseBearer` holds to strict RFC 6750. The full write-up is in
[docs/base-lacewing.md](docs/base-lacewing.md).

Signing out on the phone revokes the refresh token at `POST /api/v1/auth/logout`, then
deletes the session from the keychain. The route takes the refresh token alone, with no
access token, because the refresh token is the stronger credential and an expired access
token (`JWT_ACCESS_EXPIRY`, 15 minutes in `.env.example`) would otherwise block the sign-out.
If the server can't be reached within firefly's 8s deadline, the phone signs out anyway and
says so: that refresh token stays valid on the server until `REFRESH_TOKEN_TTL_DAYS` runs
out.

Access tokens are revocable through lacewing's `RevocationStore`. Each one carries its
session as `sid` (`refresh_tokens.session_id`, kept across rotations), and the backend
accepts it only while that session still has a live refresh token. Sign-out, a role change
and refresh-token expiry therefore end the access tokens too, on the next request rather
than after `JWT_ACCESS_EXPIRY`. The price is one indexed lookup per authenticated request,
and with Postgres down every caller is treated as signed out.

### Crypto scanning (Cephalote)

CI's `crypto-scan` job downloads a pinned Cephalote release, verifies its checksum, and
fails on any finding. Run it locally with `cephalote scan .` (it's in the AUR as
`cephalote`).

## Layout

| Path | What it is |
| --- | --- |
| `backend/` | Bun + Elysia: REST `/api/v1` (mobile), tRPC `/trpc` (web), gRPC `:50051`, OpenAPI `/openapi` |
| `backend/src/suite/` | Every Smiduweorc policy decision in one file, plus the Redis stores |
| `frontend/` | Vue 3 + tRPC. Adds the phasmid preview and the cached public feed panel |
| `api-client/` | `@suite/api-client`, generated by dung beetle; `openapi.json` is committed |
| `mobile/` | Expo SDK 57 (React Native 0.86): sign in, feed, idempotent compose |

## Checks

```sh
bun run lint        # biome
bun run typecheck   # builds api-client first, then every workspace
bun run test        # backend (vitest + PGlite), frontend, api-client, mobile
bun run build
```

`bun run test` never needs Docker. The backend runs against PGlite, and builds the suite on
the libraries' own `MemoryStore`s, except the Redis adapters, which are tested against
`ioredis-mock` through the real `Cache` and `Ledger` classes.

PGlite runs one transaction at a time, so a few things only show up on real servers: two
refreshes racing on one token, Postgres cancelling a query at `statement_timeout`, and
`SET NX` holding across connections. Those live in `backend/src/__integration__/`:

```sh
bun run db:up
INTEGRATION_DATABASE_URL=postgres://bevd:bevd@localhost:5432/bevd \
INTEGRATION_REDIS_URL=redis://localhost:6379 \
bun run test:integration   # about 6s, 5 of them waiting on statement_timeout
```

Each run creates its own database on that server, migrates it from `backend/drizzle`, and
drops it afterwards; in Redis it writes under its own key prefix and deletes only that, so
the dev data is left alone. With a URL unset, the tests that need it are reported as
skipped, and under CI that is an error. CI runs this suite against Postgres 17 and Redis 8
service containers, and also builds the backend image, checks that it contains no `.env`,
tests or `.git` and does not run as root, then boots it and calls `/health`.

The tests themselves run on Node (Vitest's runner), whichever command starts them. Bun runs
the install, and the server inside the image.

## Environment

On top of the template's variables ([docs/base-lacewing.md](docs/base-lacewing.md#environment)):

| Variable | Where | Notes |
| --- | --- | --- |
| `REDIS_URL` | backend | Feed cache and idempotency ledger. Never awaited at boot: an outage degrades rather than blocks. |
| `EXPO_PUBLIC_API_URL` | mobile | `localhost` on an iOS simulator, `10.0.2.2` on an Android emulator, your LAN IP on a phone. |
