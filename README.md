# ClaimFlow

Local dev stack: web (Vite + React), API (Express), SQLite via Prisma, and Mailpit for email.

## Prerequisites

- macOS or Linux (Windows is unsupported)
- Node `>=20 <23` and npm
- Mailpit (see below)

### Select Node 20

```sh
nvm use    # reads .nvmrc (Node 20); install with `nvm install` if missing
```

### Install Mailpit

- macOS: `brew install mailpit`
- Linux (no root; tested with 1.34.0; use `arm64` instead of `amd64` on ARM):

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/axllent/mailpit/releases/download/v1.34.0/mailpit-linux-amd64.tar.gz | tar -xz -C ~/.local/bin mailpit
export PATH="$HOME/.local/bin:$PATH"   # add to your shell profile
mailpit version
```

### Or run Mailpit in Docker

```sh
docker run -d --name mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit
MAILPIT_EXTERNAL=1 npm start
```

Stop it later with `docker stop mailpit && docker rm mailpit`.

## Setup and start

```sh
cp .env.example .env     # then set SEED_PASSWORD in .env (empty fails with SEED_PASSWORD_MISSING)
npm install
npm start
```

Never commit `.env`; it is git-ignored. `npm start` runs preflight, migrates, seeds, then starts Mailpit, the API and the web app. When it prints `Ready`, all 3 services are healthy.

Stop with Ctrl-C (SIGINT; SIGTERM and SIGHUP behave the same): every service the command started is stopped and it exits 0. During the migrate/seed steps, which run synchronously before any service starts, a signal sent only to the `npm start` process waits for the step to finish; Ctrl-C in a terminal also reaches the step and aborts it.

## Configuration and tests

- `PUBLIC_BASE_URL` (in `.env`): origin used in set-password and reset links emailed to users, e.g. `http://127.0.0.1:5173`.
- `RECEIPTS_DIR` (in `.env`, optional): where uploaded receipts are stored, default `<repo>/data/receipts` (created with mode 0700; git-ignored). Must be outside `web/`. Changing it needs an API restart and moving the existing files.
- `npm run test:api`: API tests against a throwaway SQLite database.
- `npx playwright install chromium`: one-off download needed before `npm run test:e2e` (browser and accessibility tests).
- Demo browser: use Chromium or Firefox for manual demos; the accessibility tests run on Chromium at 360x740.

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

**Manual per-service start** (if `npm start` fails). Requires `.env` in place (`DATABASE_URL`, `SEED_PASSWORD`), which the commands read.

One-shot setup, run once in any terminal:

```sh
npx prisma migrate deploy
npm run seed
```

Then three long-running services, each in its own terminal:

```sh
mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
npx tsx api/src/server.ts
npx vite --config web/vite.config.ts
```

**Port in use / orphaned processes:** replace `PORT` with the port named in the error:

```sh
lsof -ti :PORT | xargs kill
```

**Failed migration (P3009):** do not delete `prisma/dev.db`; it holds your claims and receipt data. Back it up first (`cp prisma/dev.db prisma/dev.db.bak`, and keep the receipts directory), then run `npx prisma migrate status` to see the failed migration. Fix the cause, then mark it with `npx prisma migrate resolve --applied <name>` (if its changes are in the database) or `--rolled-back <name>` (if not), and rerun `npx prisma migrate deploy`. Resetting the database is only acceptable for disposable test data (e.g. `test.db`), never for existing claims.

**Tests** (Node 20): `npm run test:unit` and `npm run test:e2e` run serially and bind the fixed ports 5173, 3001, 1025 and 8025, so stop `npm start` and anything else on those ports first.

**API in test mode** (every stdout line is JSON, for log checks): `npm run -s start:api:test`
