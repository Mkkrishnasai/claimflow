# ClaimFlow

Local dev stack: web (Vite + React), API (Express), SQLite via Prisma, and Mailpit for email.

## Prerequisites

- macOS or Linux (Windows is unsupported)
- Node `>=20 <23` and npm
- Mailpit (see below)

### Install Mailpit

- macOS: `brew install mailpit`
- Linux: use the official install script or put the release binary from https://github.com/axllent/mailpit/releases on your `PATH`.

### Or run Mailpit in Docker

```sh
docker run -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit
MAILPIT_EXTERNAL=1 npm start
```

## Setup and start

```sh
cp .env.example .env     # then set SEED_PASSWORD in .env (empty fails with SEED_PASSWORD_MISSING)
npm install
npm start
```

Never commit `.env`; it is git-ignored. `npm start` runs preflight, migrates, seeds, then starts Mailpit, the API and the web app. When it prints `Ready`, all 3 services are healthy.

## Ports

| Port | Service |
|------|---------|
| 5173 | web |
| 3001 | API |
| 1025 | Mailpit SMTP |
| 8025 | Mailpit UI |

## Seeded identities

All use the password from `SEED_PASSWORD`.

| Email | Role | Manager |
|-------|------|---------|
| senior.manager@claimflow.test | manager | none |
| manager@claimflow.test | manager | senior.manager@claimflow.test |
| employee@claimflow.test | employee | manager@claimflow.test |
| finance@claimflow.test | finance | senior.manager@claimflow.test |
| admin@claimflow.test | admin | senior.manager@claimflow.test |

## Troubleshooting

**Manual per-service start** (if `npm start` fails), each in its own terminal:

```sh
npx prisma migrate deploy
npm run seed
mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
npx tsx api/src/server.ts
npx vite --config web/vite.config.ts
```

**Port in use / orphaned processes:** replace `PORT` with the port named in the error:

```sh
lsof -ti :PORT | xargs kill
```

**Failed migration (P3009):** delete `prisma/dev.db` and rerun `npm start`.

**API in test mode** (every stdout line is JSON, for log checks): `npm run -s start:api:test`
