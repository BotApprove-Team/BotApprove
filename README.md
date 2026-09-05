<p align="center">
  <img src="botapprove-avatar-512.png" alt="BotApprove" width="120" height="120">
</p>

<h1 align="center">BotApprove</h1>

<p align="center">
  Every bot that joins your server is kicked on sight and held for a human decision.<br>
  No exceptions, not even for the owner.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="AGPL-3.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18.17-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=18.17">
  <img src="https://img.shields.io/badge/discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white" alt="discord.js v14">
  <img src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Stripe-billing-635BFF?style=flat-square&logo=stripe&logoColor=white" alt="Stripe">
</p>

<p align="center">
  <a href="https://botapprove.mikuuu.xyz">Dashboard</a> &nbsp;·&nbsp;
  <a href="https://discord.com/oauth2/authorize?client_id=1545551180640288828&permissions=67226758&scope=bot%20applications.commands">Add to Discord</a> &nbsp;·&nbsp;
  <a href="https://botapprove.mikuuu.xyz/pricing">Pricing</a> &nbsp;·&nbsp;
  <a href="https://botapprove.mikuuu.xyz/blog">Blog</a> &nbsp;·&nbsp;
  <a href="https://botapprove.mikuuu.xyz/terms">Terms</a> &nbsp;·&nbsp;
  <a href="https://botapprove.mikuuu.xyz/privacy">Privacy</a>
</p>

---

## The problem

A nuke bot does not need to outsmart your moderators. It needs one person with
Manage Server to click an invite link once. By the time anyone notices, the
channels are gone.

Most protection bots react to the damage. BotApprove stops the bot from being
in the server at all until somebody says yes.

## How it works

A bot joins. Before it can do anything:

1. **Threat list.** If it is on the shared known-nuke-bot database, it is banned
   outright and the account that invited it is dealt with per your settings.
2. **Keyword check, before the whitelist.** A name matching your blocklist is
   kicked even if the bot carries Discord's verified badge. Verified apps get
   compromised too.
3. **Whitelist.** A bot you have already approved is allowed through, and stops
   here.
4. **Kick first.** Anything else is removed immediately, before any lookups
   happen. It never sits in the server while an audit log is fetched.
5. **Ask a human.** Only then does the approval card go out: who invited it,
   what permissions it was granted, account age, avatar analysis, and any flags
   raised along the way.

Approving does not re-add the bot. You invite it again yourself, deliberately.

If any step throws an exception, the bot is kicked. An error is never
indistinguishable from an approval.

## Free forever

The core guard never switches off, whether you pay or not:

| | |
|---|---|
| Approval gate | Every joining bot held for review |
| Keyword blocking | Default high-risk name list |
| Audit trail | Every kick, approval and denial recorded |
| Tamper detection | Alerts if BotApprove's own role or permissions are changed |
| Dashboard | Web configuration and approvals |

Premium adds custom keywords, the shared threat database, permission drift
alerts, impersonation detection, account age floors, two-person approval,
approval expiry and log channel mirroring.

## Self-hosting

```bash
git clone https://github.com/BotApprove-Team/BotApprove.git
cd BotApprove
npm install
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `SESSION_SECRET`, then:

```bash
npm run register
npm start
```

The bot needs **Kick Members**, **Ban Members**, **View Audit Log** and the
**Server Members** privileged intent, and its role must sit above wherever new
bots land. It tells you if any of that is missing.

## Tests

No Discord connection required. Each suite runs against a scratch database:

```bash
DATABASE_PATH=./data/test.db node scripts/smoke.js
```

`smoke`, `admin-auth-check`, `blog-check`, `announce-check`, `embed-check` and
`trial-check` cover the pipeline, operator elevation, the blog renderer,
announcement delivery, embed limits and the billing trial.

---

## TL;DR

**What is it?** A bouncer for bots. Nothing gets in without a human saying yes.

**Does it slow my server down?** No. Bots you have already approved join
normally. The gate only fires on bots it does not recognise.

**What if the owner invites something?** Same treatment. Ownership is not a
trust level.

**What happens if it breaks?** It kicks. Every failure path ends in removal,
including unexpected exceptions.

**Is the free version crippled?** No. The approval gate, keyword blocking, audit
trail and tamper detection never expire. Paying adds extras, it does not switch
the guard back on.

**Can I self-host it?** Yes, it is AGPL-3.0. Run it, modify it, publish your
changes.

**Where does my data go?** A local SQLite file. No third party, no telemetry.

<p align="center">
  <sub>AGPL-3.0 · built by <a href="https://github.com/cfm-miku-en">cfm-miku-en</a></sub>
</p>
