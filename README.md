# JASLIN GAME

JASLIN is a Telegram Mini App mining game built on TON.

## Production Stack

- Telegram Mini App
- Node.js / Express
- Vercel
- Supabase / PostgreSQL
- TON / Jetton
- TON Connect
- X OAuth / social tasks

## Repository Structure

```text
JASLIN-GAME/
├── server.js
├── package.json
├── package-lock.json
├── .gitignore
├── README.md
├── public/
│   └── index.html
└── migrations/
    ├── 001_base.sql
    ├── 002_x_tasks.sql
    ├── 003_auto_withdraw.sql
    └── 004_security_hardening.sql
```

## Security Rules

- Never commit seed phrases, private keys, bot tokens, Supabase secret keys, X client secrets, or encryption keys.
- Secrets belong only in Vercel Environment Variables.
- The frontend must not directly determine balances or authorize rewards.
- Sensitive Supabase tables are accessed through the trusted server using the service role.
- Wallet ownership must be verified before Holding Power or withdrawals are enabled.
- Keep only a limited payout balance in the hot wallet.
- Do not manually refund a submitted withdrawal until its on-chain status has been checked.

## Wallet & Withdrawals

JASLIN uses a dedicated hot wallet for automatic withdrawals.

Current withdrawal policy:

- Minimum withdrawal: 2,000 JASLIN
- Withdrawal fee: 300 JASLIN
- User receives: 1,700 JASLIN for a 2,000 JASLIN withdrawal
- Withdrawal cooldown: 24 hours
- Beta daily payout cap should remain enabled
- Network gas is paid by the hot wallet

Wallet ownership verification is required before a wallet can be used for Holding Power or withdrawals.

## Mining

Mining rewards are calculated by the server.

Important rules:

- The browser is not trusted to determine balances.
- Claim operations must be concurrency-safe.
- Mining balance updates and referral mining commissions should be committed atomically.
- Reward changes must be reviewed against the JASLIN emission model before production deployment.

## Referral

Referral attribution comes from verified Telegram launch data.

The system must prevent:

- Self-referrals
- Reassigning established accounts to another referrer
- Duplicate referral rewards
- Client-side manipulation of referral balances

## Social Tasks

X tasks use server-side OAuth and verification.

OAuth tokens and encryption keys must never be exposed to the browser or committed to GitHub.

## Database Migrations

The `migrations/` directory is the canonical schema history for a fresh installation.

Do not rerun historical migrations blindly against the existing production database.

Production already contains earlier JASLIN schema changes and patches. New production changes should be added as a new migration after reviewing the current database state.

## Environment Variables

Examples of non-secret configuration:

```text
BOT_USERNAME=JaslinEarnBot
TON_NETWORK=mainnet
TON_PROOF_DOMAIN=jaslin-game.vercel.app
TON_PROOF_MAX_AGE_SECONDS=900
WITHDRAWALS_ENABLED=true
HOT_WALLET_MIN_GRAM=0.15
AUTO_WITHDRAW_DAILY_CAP_JASLIN=20000
WITHDRAW_COOLDOWN_HOURS=24
```

Secrets include:

```text
BOT_TOKEN
SUPABASE_SECRET_KEY
JASLIN_HOT_WALLET_MNEMONIC
TONCENTER_API_KEY
TREASURY_ADMIN_KEY
X_CLIENT_SECRET
X_TOKEN_ENCRYPTION_KEY
TELEGRAM_WEBHOOK_SECRET
```

Never place real secret values in this README, `.env.example`, screenshots, issues, or commits.

## Deployment

Production deployment flow:

1. Review database migration.
2. Apply only the required new migration to Supabase.
3. Update `server.js` and/or `public/index.html`.
4. Commit changes to GitHub.
5. Verify Vercel Environment Variables.
6. Deploy to Vercel.
7. Check the production deployment and logs.
8. Test Telegram login, mining, referral, wallet verification, X tasks, and withdrawal with a controlled test account.

## UI Direction

JASLIN keeps its dark premium Core identity.

Product direction:

- Keep short sound effects.
- Use Telegram haptic feedback where useful.
- Provide a Reduce Motion option.
- Avoid looping background music.
- Avoid unnecessary features that increase token emissions without improving retention.

## Production Safety

Before a large public launch:

- Verify wallet ownership flow.
- Test withdrawal reconciliation.
- Test concurrent mining claims.
- Confirm rate limiting across serverless instances.
- Review Supabase Security Advisor.
- Review Vercel logs.
- Review GitHub for accidentally committed secrets.
- Back up the production database.
- Keep a withdrawal circuit breaker/daily cap enabled.

## Important

Never share a wallet recovery phrase or private key with JASLIN support, Telegram users, GitHub, or any web form.
