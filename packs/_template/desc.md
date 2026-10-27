# Example pack

This directory is a starting point, not an installed pack. It is intentionally
left out of `packs/index.json`.

## What it shows

- `pack.json`: identity, version, description, host patterns and author.
- `tools.js`: one read-only tool plus a short prompt.
- `desc.md`: the long description shown in the FoxAgent Packs panel.
- `icon.svg`: a 32 by 32 icon.

## Make it yours

1. Copy the directory to `packs/<your-id>`.
2. Edit `pack.json`: id, name, version, description, hosts.
3. Replace the example tool and prompt.
4. Add `<your-id>` to `packs/index.json`.
5. Import the module in `packs/registry.js`.
6. Run `node --test tests/logic.test.mjs` and `npx web-ext lint`.
7. Open Packs in the sidebar and install it.

## Rules

- Read only by default. A pack that changes a site needs a clear reason and the
  standard `act` or `write` risk level so the user approves each call.
- Never ship credentials, tokens or tracking code.
- Keep prompt text short. It is added to every request while the pack matches.
- Tools must use `pageTab(args, ctx)` so an explicit tab id wins but the default
  stays on the task's pinned tab.
