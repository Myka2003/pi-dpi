# npm Publish Checklist

1. `npm whoami` — confirm you're logged in to npm with publish rights for the scope
2. Update version in `package.json` (semver) and add a CHANGELOG entry
3. `npm run typecheck && npm run test` — all green
4. `npm pack --dry-run` — verify tarball contents (no node_modules, no .git, includes files listed)
5. `npm publish` (or `npm publish --tag beta` for a pre-release)
6. Verify: `pi install npm:<package>@<version>` on a clean machine
7. Tag the release: `git tag v<version> && git push --tags`
