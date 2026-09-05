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

## AI-assisted contributions

Using an AI to write code here is allowed. Four conditions come with it, and
they are not negotiable.

**It has to actually run.** Every suite in `scripts/` passes, and you have
exercised the change against a real Discord server or covered it with a check.
A patch that looks right is not a patch that works, and this is a security tool:
a plausible-looking change that quietly weakens the gate is worse than no change
at all.

**Say that it was AI-assisted.** Put it in the pull request description. Not as
a confession, as a review instruction: it tells a reviewer to read for confident
nonsense rather than for typos, which is a different kind of reading.

**You have to understand it.** If you cannot explain what a line does, why it is
there, and what breaks without it, the change is not ready. Expect questions in
review and expect to answer them yourself. You are the author; the model was a
tool you used.

**Maintainers may change or revert it.** If a merged AI-assisted change turns
out to introduce a security flaw, it gets fixed or removed immediately, without
waiting for you. That is true of any contribution here, and it is stated plainly
because generated code fails in a particular way: confidently, and in the
security-relevant details.

Read the invariants below before you prompt anything. They are the parts a model
is most likely to "tidy up", and every one of them exists because removing it
gets a server wiped.

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
