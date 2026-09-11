/** Binds receipt admission/publication to current Git observations and SSH verification. */
import { createAuthorityApplicationReceiptOperations } from '../modules/authority/authority-application-receipt.ts';
import { authorityApplicationReceiptRepository } from '../runtime/repository-observation/authority-application-receipt.ts';
import { verifySshDataSignature } from '../adapters/signing/ssh/ci-signature.ts';

export const authorityApplicationReceipts =
  createAuthorityApplicationReceiptOperations({
    ...authorityApplicationReceiptRepository,
    verifySshDataSignature,
  });

export const {
  verifyAuthorityApplicationReceiptSignature,
  listAuthorityApplicationReceiptTagRefs,
  readAuthorityApplicationReceiptTag,
  publishAuthorityApplicationReceipt,
} = authorityApplicationReceipts;
