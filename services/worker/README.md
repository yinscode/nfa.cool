# Settlement observation

`settlement.mjs` checks Sepolia chain ID, transaction hash, sender, nonce,
block identity and a minimum confirmation count. An RPC timeout, missing
receipt, mismatched data or insufficient confirmations returns `UNCERTAIN`.
Only a confirmed result can become `report_evm_receipt` arguments. The
reporter remains a trusted component; this module does not prove a foreign
receipt on NEAR. Tests inject timeouts and forged observations.
