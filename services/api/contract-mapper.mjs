const lifecycle = {Active:'ACTIVE',Draining:'DRAINING',Listed:'LISTED',TransferCallPending:'TRANSFER_CALL_PENDING'};
const status = {Requested:'REQUESTED',Submitted:'SUBMITTED',Finalized:'FINALIZED',Failed:'FAILED',Uncertain:'UNCERTAIN'};
export function agentIdentity(registryAccountId, tokenId, token, record) {
  if (!token || !record || !lifecycle[record.lifecycle]) throw Error('Unknown agent or lifecycle');
  return {registryAccountId,tokenId,vaultAccountId:record.vault_id,
    ownerAccountId:token.owner_id,ownerEpoch:record.epoch,lifecycle:lifecycle[record.lifecycle],
    manifestHash:record.manifest_hash,manifestUri:record.manifest_uri};
}
export function operationRecord(view, agent) {
  if (!view || !agent || !status[view.status]) throw Error('Unknown operation/status');
  return {id:view.id,tokenId:view.token_id,ownerEpoch:view.epoch,kind:view.kind,
    status:status[view.status],vaultAccountId:agent.vault_id,requestedBy:view.requested_by,
    recipient:view.recipient,amount:String(view.amount)};
}
