/** Binds audit use cases to the exact CLI grammar, private input reader and durable ledger owners. */
import { createAuthorityAuditOperations } from '../application/control-plane/authority-audit.ts';
import {
  createAuthorityAuditInputReader,
  readAuthorityAuditPolicyAtHead,
} from '../runtime/repository-observation/authority-audit-input.ts';
import { discoverRepository } from '../runtime/repository-transaction/git-working-state.ts';
import {
  parseArguments,
  authorityAuditUsage,
  auditUsageError,
  protectedConfigurationInputInvalid,
  inputFileUnsafe,
  destructionGrantFileInvalid,
} from '../adapters/command-line/authority-audit-input.ts';
import { scanAuthorityAuditLedger } from '../runtime/storage-journal/authority-audit-ledger.ts';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../runtime/storage-journal/authority-audit-service.ts';
import {
  configureProtectedAuthorityAuditLedger,
  createPinnedAuthorityAuditAnchorBackend,
  createPinnedAuditDestructionSignatureVerifier,
  anchorProtectedAuthorityAuditLedger,
  verifyProtectedAuthorityAuditAnchors,
  destroyProtectedAuthorityAuditLedger,
} from '../runtime/storage-journal/authority-audit-protected.ts';
const errors = {
  auditUsageError,
  protectedConfigurationInputInvalid,
  inputFileUnsafe,
  destructionGrantFileInvalid,
};
const operations = createAuthorityAuditOperations(
  {
    scanAuthorityAuditLedger,
    showAuthorityAuditTask,
    verifyAuthorityAuditEvents,
    configureProtectedAuthorityAuditLedger,
    createPinnedAuthorityAuditAnchorBackend,
    createPinnedAuditDestructionSignatureVerifier,
    anchorProtectedAuthorityAuditLedger,
    verifyProtectedAuthorityAuditAnchors,
    destroyProtectedAuthorityAuditLedger,
  },
  { discoverRepository, readPolicyAtHead: readAuthorityAuditPolicyAtHead },
  createAuthorityAuditInputReader(errors),
  errors,
);
export const authorityAuditCommands = {
  ...operations,
  parseArguments,
  usage: authorityAuditUsage,
};
