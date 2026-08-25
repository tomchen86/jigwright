#!/usr/bin/env node

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (
    value === undefined ||
    !['--change', '--preparation', '--grant'].includes(name) ||
    argumentsByName.has(name)
  ) {
    fail('ARCHIVE_MANUAL_HARNESS_USAGE_INVALID');
  }
  argumentsByName.set(name, value);
}

if (
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(argumentsByName.get('--change') ?? '') ||
  !/^sha256:[0-9a-f]{64}$/.test(argumentsByName.get('--preparation') ?? '') ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    argumentsByName.get('--grant') ?? '',
  )
) {
  fail('ARCHIVE_MANUAL_HARNESS_INPUT_INVALID');
}

process.stderr.write(
  `${JSON.stringify({
    ok: false,
    code: 'ARCHIVE_MANUAL_HARNESS_DISABLED',
    implementationReady: false,
    realPilotPending: true,
    fullGatePending: true,
    reason:
      'Production token, authenticated ruleset, and exact branch publisher composition is not enabled.',
  })}\n`,
);
process.exitCode = 13;

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exit(2);
}
