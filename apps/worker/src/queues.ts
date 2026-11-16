/** Queue names shared by the API (producer) and the worker (consumer). */
export const QUEUES = {
  CODE_GRADING: 'code-grading', // Sprint 6 - Judge0
  CERTIFICATE_PDF: 'certificate-pdf', // Sprint 9
  EMAIL: 'email', // Sprint 1 (OTP), Sprint 9 (certificates)
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
