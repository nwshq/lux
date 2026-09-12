# Security and secret hygiene

## Never commit credentials or generated build output

- Keep credentials in a secret manager or local environment only.
- Never track `.env` or `.env.*` files. Sanitized `.env.example`, `.env.sample`, and `.env.template` files are the only allowed exceptions.
- Never track Next.js `.next/` output. It can contain generated Server Function encryption keys and preview-mode signing/encryption material.

The repository enforces these rules with:

- `npm run verify:repository-hygiene` for deterministic tracked-path checks.
- `npm run scan:secrets` for a redacted Gitleaks scan of every reachable Git ref.
- The CI `secret-scan` job, which fetches full history before running both checks.

## Local pre-push protection

Install the repository's pre-push hook without replacing any existing hook:

```sh
ln -s ../../bin/pre-push-secret-scan.sh .git/hooks/pre-push
```

If `.git/hooks/pre-push` already exists, integrate these two commands into it instead:

```sh
npm run verify:repository-hygiene
npm run scan:secrets
```

The scan is intentionally fail-closed. Do not add allowlist entries merely to make CI green. Confirm that a finding is non-secret, document the rationale in review, and narrowly suppress only the exact false positive.

## If a credential is committed

1. Stop using and revoke or rotate it immediately.
2. Make the repository private while exposure is assessed.
3. Review provider usage and billing logs for abuse.
4. Rewrite every affected ref; deleting the file in a later commit is insufficient.
5. Account for GitHub-managed pull-request refs, releases, caches, packages, forks, clones, mirrors, bundles, and deployment checkouts.
6. Validate the rewritten history with at least two independent scanners before restoring public visibility.
