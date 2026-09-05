## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was tested

<!-- Which suites you ran, and what you exercised on a real server. -->

```
DATABASE_PATH=./data/test.db node scripts/smoke.js
```

## Checklist

- [ ] Every suite in `scripts/` passes
- [ ] Commits are signed off (`git commit -s`)
- [ ] Deny-by-default still holds: every path that is not an explicit allow ends in a kick
- [ ] The keyword check still runs before the whitelist
- [ ] Anything security-relevant has a check covering it

## AI assistance

- [ ] This change was written or substantially assisted by an AI

If ticked: you have run it, you understand every line, and you can answer
questions about it in review. See [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).
