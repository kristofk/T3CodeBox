# T3CodeBox docs

How T3CodeBox works and why, for people and agents who change it. Using T3CodeBox is in the
[README](../README.md); the pull request flow is in [CONTRIBUTING.md](../CONTRIBUTING.md).

- [Architecture](architecture.md): the two images, what runs in them, the dashboard, CI and releases.
- [External tools](external-tools.md): what T3 Code, the provider CLIs, `skills` and Chromium actually do,
  checked against running versions. The image's scripts and the dashboard's parsers rely on these facts.
- [Decisions](decisions.md): what was decided and why, including what was tried and dropped.

These pages hold the current state only. When a change makes a page wrong, fix the page in the same pull
request; git history keeps the old versions. Work still to do is in the
[issues](https://github.com/kristofk/T3CodeBox/issues), not here.
