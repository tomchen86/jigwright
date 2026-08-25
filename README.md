# Jigwright

Jigwright is a repository-owned workflow harness for well-intentioned AI
agents. This migration repository preserves the frozen current-v3 engine
closure before consumer assumptions are removed and the final single-package
layout is produced.

The package-side engine can currently operate on a separate local consumer:

```bash
pnpm jigwright --repository-root /absolute/path/to/consumer doctor --json
```

This repository has no configured remote. Nothing in this migration checkpoint
publishes an npm package or performs real external operations.
