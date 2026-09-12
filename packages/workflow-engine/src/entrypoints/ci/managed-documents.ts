/** Runs the pinned managed-document check with the production document readers. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateManagedDocuments } from '../../composition-root/managed-documents-production.ts';

if (
  process.argv[1] !== undefined &&
  pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url
) {
  process.stdout.write(
    `${JSON.stringify({
      command: 'documents',
      ok: true,
      validated: validateManagedDocuments(process.cwd()),
    })}\n`,
  );
}
