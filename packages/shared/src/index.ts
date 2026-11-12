/** Permanent identity across owner and vault control changes. */
export type NfaRef = Readonly<{
  registryAccountId: string;
  tokenId: string;
}>;

export type Lifecycle = 'ACTIVE' | 'DRAINING' | 'LISTED' | 'TRANSFER_CALL_PENDING';
export type OperationStatus = 'REQUESTED' | 'SUBMITTED' | 'FINALIZED' | 'FAILED' | 'UNCERTAIN';
export type OperationKind = 'NEAR_TRANSFER' | 'EVM_TRANSFER' | 'JOB';

export type NfaIdentity = Readonly<NfaRef & {
  vaultAccountId: string;
  ownerAccountId: string;
  ownerEpoch: number;
  lifecycle: Lifecycle;
  manifestHash: string;
  manifestUri: string;
}>;

export type Operation = Readonly<{
  id: number;
  tokenId: string;
  ownerEpoch: number;
  kind: OperationKind;
  status: OperationStatus;
  vaultAccountId: string;
  requestedBy: string;
  recipient: string;
  amount: string;
  nonce?: number;
  foreignTxHash?: string;
}>;

export type NfaManifest = Readonly<{
  schemaVersion: 1;
  publicCharacter: { collection: string; seed: string; traits: Record<string, string> };
  skills: ReadonlyArray<{ id: string; version: string; hash: string }>;
  verifiedCredentials: ReadonlyArray<{ issuer: string; hash: string; expiresAt?: string }>;
  memoryRoot?: string;
  access: ReadonlyArray<{ provider: string; transfer: 'LIVE_CHECK' | 'RECONNECT' | 'NONTRANSFERABLE' }>;
}>;

export type NfaEvent = Readonly<{
  standard: 'nfa';
  version: '1.0.0';
  event: 'provision_requested' | 'provision_failed' | 'provision_finalized' |
    'operation_requested' | 'operation_finalized' | 'operation_uncertain' |
    'transfer_locked' | 'transfer_finalized' | 'transfer_rolled_back';
  data: ReadonlyArray<Record<string, unknown>>;
}>;

export type NfaListing = Readonly<{
  seller: string; epoch: number; nonce: number; price: string;
  expires_at_ns: number; manifest_hash: string;
}>;

export type ScoutJob = Readonly<{
  id: number; epoch: number; requester: string; brief_hash: string;
  source_hash: string; fee: string; deadline_ns: number;
  status: 'REQUESTED' | 'FINALIZED' | 'FAILED';
  output_hash: string | null; output_uri: string | null;
}>;

export type NfaGrant = Readonly<{
  epoch: number; delegate: string; method: 'NEAR_TRANSFER' | 'SCOUT_RUN';
  recipient: string | null; remaining: string; expires_at_ns: number;
}>;

export type DerivedWallet = Readonly<{
  chain_id: number; signer_id: string; path: string; domain_id: number;
  public_key: string; address: string;
}>;
