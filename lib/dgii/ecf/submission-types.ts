export const DGII_TARGET_ENVIRONMENT = "testecf" as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type SubmissionStatus =
  | "submitting"
  | "received"
  | "processing"
  | "accepted"
  | "accepted_conditional"
  | "rejected"
  | "not_found"
  | "authentication_failed"
  | "communication_failure"
  | "indeterminate";

export type StoredDgiiMessage = {
  code: string | number | null;
  value: string;
};

export type SubmissionRecord = {
  id: string;
  environment: typeof DGII_TARGET_ENVIRONMENT;
  issuerRnc: string;
  encf: string;
  idempotencyKey: string;
  inputHash: string;
  xmlHash: string;
  encryptedXml: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
  };
  status: SubmissionStatus;
  trackId: string | null;
  receptionHttpStatus: number | null;
  dgiiStatusCode: number | null;
  dgiiStatusText: string | null;
  sequenceUsed: boolean | null;
  messages: StoredDgiiMessage[];
  diagnostic: JsonObject | null;
  submittedAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SubmissionInsert = Omit<
  SubmissionRecord,
  | "trackId"
  | "receptionHttpStatus"
  | "dgiiStatusCode"
  | "dgiiStatusText"
  | "sequenceUsed"
  | "messages"
  | "diagnostic"
  | "submittedAt"
  | "lastCheckedAt"
  | "createdAt"
  | "updatedAt"
>;

export type ClaimResult =
  | { kind: "claimed"; record: SubmissionRecord }
  | { kind: "existing"; record: SubmissionRecord }
  | { kind: "idempotency_conflict"; record: SubmissionRecord }
  | { kind: "document_conflict"; record: SubmissionRecord };

export type SubmissionPatch = Partial<
  Pick<
    SubmissionRecord,
    | "status"
    | "trackId"
    | "receptionHttpStatus"
    | "dgiiStatusCode"
    | "dgiiStatusText"
    | "sequenceUsed"
    | "messages"
    | "diagnostic"
    | "submittedAt"
    | "lastCheckedAt"
  >
>;

export interface SubmissionRepository {
  claim(input: SubmissionInsert): Promise<ClaimResult>;
  findById(id: string): Promise<SubmissionRecord | null>;
  update(id: string, patch: SubmissionPatch): Promise<SubmissionRecord>;
}
