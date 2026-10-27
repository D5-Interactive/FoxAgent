# Packs

A pack is a small directory that adds site-specific tools and a short playbook
to FoxAgent. Packs ship with the extension, so the Packs panel installs by
enabling one; it never downloads or runs code from the network.

## Layout

```
packs/
├── index.json          # ids shown in the Packs panel, in order
├── registry.js         # static imports of every pack module
├── sdk.js              # helpers available to pack modules
├── canvas/
│   ├── pack.json       # id, name, version, description, hosts, author
│   ├── tools.js        # export const tools = [...]; export const prompt = "..."
│   ├── desc.md         # long description in the pack viewer
│   └── icon.svg        # 32 by 32
└── _template/          # copy this, not installed
```

## pack.json

```json
{
  "id": "canvas",
  "name": "Canvas LMS",
  "version": "1.0.0",
  "description": "One sentence for the pack card.",
  "hosts": ["*.instructure.com", "canvas.*"],
  "author": "D5 Interactive"
}
```

`hosts` accepts `*` wildcards. An empty list means every site.

## tools.js

Export `tools` and a short `prompt`. Tools use the same fields as the built-in
registry: `name`, `description`, `risk` (`read`, `act` or `write`), `needsPage`,
`parameters` and `run(args, ctx)`. Import helpers from `../sdk.js`:
`pageTab`, `fetchAllRows`, `clip`, `lines`, `hostOf`, `hostMatches`.

## Installing

The Packs panel lists every id in `index.json`, with its icon, name and
description from `desc.md`. Install enables the pack for this profile. The
panel's "Check for new packs" compares the catalog against
`https://raw.githubusercontent.com/D5-Interactive/FoxAgent/main/packs/index.json`
and marks packs that a newer release adds.

## Contributing a pack

Open a pull request with the directory, an `index.json` entry, a real `desc.md`
and an icon. Packs must be read-only by default, must not ship credentials, and
must not bypass a site's access controls.
