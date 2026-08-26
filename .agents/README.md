# Repository skill mirror maintenance

`.agents/skills/` and `.codex/skills/` contain byte-identical reviewed mirrors
of the three repository skills. Regenerate or update both copies in one
reviewed change and verify them with `pnpm workflow openspec-assets check
--json`.
