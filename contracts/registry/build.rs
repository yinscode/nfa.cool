use std::path::PathBuf;
use sha2::{Digest, Sha256};

fn main(){
    println!("cargo:rerun-if-env-changed=NFA_VAULT_WASM_PATH");
    let path=std::env::var_os("NFA_VAULT_WASM_PATH").map(PathBuf::from).unwrap_or_else(||
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            // The size-optimized vault: it is deployed inside `create_agent` and by guardian
            // upgrades (512 KB cap), and it is embedded in a registry that must stay under
            // NEAR's 1.5 MiB transaction size.
            .join("../vault-v2/target/wasm32-unknown-unknown/release/nfa_vault_opt.wasm"));
    println!("cargo:rerun-if-changed={}",path.display());
    println!("cargo:rustc-env=NFA_EMBEDDED_VAULT_WASM={}",path.display());
    let bytes=std::fs::read(&path).expect("embedded vault WASM");
    let digest=Sha256::digest(&bytes).iter().map(|b|format!("{b:02x}")).collect::<String>();
    println!("cargo:rustc-env=NFA_EMBEDDED_VAULT_SHA256={digest}");
}
