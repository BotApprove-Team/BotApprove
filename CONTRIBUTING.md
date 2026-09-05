# Contributing

## Sign your commits

Every commit needs a `Signed-off-by` line. It certifies that you wrote the code,
or otherwise have the right to submit it under the project's licence. The full
text is in [DCO](DCO), and it is the same one the Linux kernel uses.

Git adds the line for you:

```bash
git commit -s -m "Fix the thing"
```

That appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email have to match the commit author. If you forget on your last
commit:

```bash
git commit --amend -s --no-edit
```

For several commits, rebase and sign them all:

```bash
git rebase --signoff main
```

A pull request with unsigned commits fails its check. Nothing else about the
contribution is affected, and there is no separate agreement to sign.

## Before you open a pull request

Run the suites. None of them need a Discord connection, and each one uses a
scratch database:

```bash
for s in smoke admin-auth-check blog-check announce-check embed-check trial-check; do
  DATABASE_PATH=./data/test-$s.db node scripts/$s.js || break
done
```

Anything touching the join pipeline, entitlements, or operator elevation should
come with a check in the relevant suite. These are the paths where a mistake
means a server gets nuked, so they are worth the extra few lines.

## What the project cares about

BotApprove is a security tool, so correctness beats convenience:

- **Deny by default.** Every path that is not an explicit allow ends in a kick,
  including unexpected exceptions. An error must never look like an approval.
- **The keyword check runs before the whitelist.** Do not reorder it.
- **Re-invite tokens are consumed by deletion**, not by a flag, so they cannot
  be replayed.
- **Destructive actions go through the service layer**, not through event
  handlers, so there is one place to audit.
- **Owners get no exception.** Ownership is not a trust level.

## Style

Match the surrounding code. Two-space indent, single quotes, semicolons. The
codebase is deliberately light on comments: prefer a clear name over a comment
explaining an unclear one.
