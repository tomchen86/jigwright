import fs from 'node:fs';

// Packaged init runs before repository runtime setup and uses its compiled
// projection; source checkouts use Node's built-in TypeScript support.
const setupModule = fs.existsSync(
  new URL('./installed-runtime.json', import.meta.url),
)
  ? new URL(
      '../dist/runtime/modules/adoption/setup-questions.js',
      import.meta.url,
    )
  : new URL('../src/modules/adoption/setup-questions.ts', import.meta.url);
const setup = await import(setupModule.href);

export const initializeJigwrightConsumer = setup.initializeJigwrightConsumer;
export const configuredJigwrightEnvironment =
  setup.configuredJigwrightEnvironment;

const outputModule = fs.existsSync(
  new URL('./installed-runtime.json', import.meta.url),
)
  ? new URL(
      '../dist/runtime/entrypoints/cli/human-command-output.js',
      import.meta.url,
    )
  : new URL('../src/entrypoints/cli/human-command-output.ts', import.meta.url);
export const renderHumanCommandResult = (await import(outputModule.href))
  .renderHumanCommandResult;
