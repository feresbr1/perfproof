# Security Policy

Only the latest release and https://feresbr1.github.io/perfproof/ receive fixes. Report
vulnerabilities privately through
[GitHub security advisories](https://github.com/feresbr1/perfproof/security/advisories/new), not in
public issues.

## What is in scope

- **Generated HTML.** `flamegraph.html` embeds profile data (function names, file paths, source
  snippets) as escaped JSON. A profile whose content runs script when the file is opened is a
  vulnerability.
- **The web viewer.** Dropped files are parsed in the browser and never uploaded; the site has no
  accounts, cookies or storage worth stealing. A crafted `.cpuprofile` that runs script in the page is
  a vulnerability.
- **The CLI** runs the command you give it, exactly as your shell would, with extra `NODE_OPTIONS`.
  Anything that makes perfproof run something else is a vulnerability.

## Good to know

- Profiles and reports contain absolute file paths and snippets of your source code. Review them
  before sharing; runs are kept in `.perfproof/`, which ignores itself in git.
- perfproof sends nothing over the network.
