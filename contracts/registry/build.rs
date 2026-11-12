use std::path::PathBuf;

fn main(){
    println!("cargo:rerun-if-env-changed=NFA_VAULT_WASM_PATH");
    let path=std::env::var_os("NFA_VAULT_WASM_PATH").map(PathBuf::from).unwrap_or_else(||
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("../vault-v2/target/wasm32-unknown-unknown/release/nfa_vault.wasm"));
    println!("cargo:rerun-if-changed={}",path.display());
    println!("cargo:rustc-env=NFA_EMBEDDED_VAULT_WASM={}",path.display());
}
