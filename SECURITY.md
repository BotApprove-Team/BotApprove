# Security policy

## Reporting a vulnerability

**Do not open a public issue.** BotApprove is what stands between a server and a
nuke bot, so a public report is a working exploit against every server running
it until a fix ships.

Email **miku@mikuuu.xyz** with:

- What the flaw lets someone do
- The steps to reproduce it
- The version or commit you tested against

You will get a reply within 72 hours. If you do not, assume the email went
missing and say so in the support server without describing the flaw.

## What counts

Anything that gets a bot past the gate, or gets a person past a permission
check. Some examples, not a complete list:

- A bot joining without being kicked or held for approval
- Reaching another server's dashboard, settings, or audit log
- Redeeming a licence you do not hold, or keeping premium after it lapses
- Operator elevation without both passwords
- Reading or writing the shared threat list without being the operator
- A re-invite token that can be replayed, or used for a different bot

Denial of service against the public site, missing security headers with no
demonstrated impact, and reports produced by a scanner with no working
reproduction are out of scope.

## Handling

Confirmed reports are fixed before they are described publicly. Where a fix
changes behaviour that servers rely on, the change is announced through the
in-app announcement system so operators are not surprised by it.

You will be credited in the release notes unless you ask not to be. There is no
bounty programme; this is one person running a free tier.
