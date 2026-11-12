//! Deterministic extractive Scout. Sources are untrusted data; no tool or signer exists here.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read};
mod research;

#[cfg(target_os = "wasi")]
wit_bindgen::generate!({path:"wit", world:"nfa", generate_all});

// OutLayer chooses the vault predecessor, rather than the human transaction signer.
#[cfg(target_os = "wasi")]
#[used]
#[link_section = "outlayer.manifest"]
static MANIFEST: [u8; 33] = *br#"{"storage_account":"predecessor"}"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    operation: String, job_id: u64, question: Option<String>, sources: Option<Vec<SourceInput>>,
    expected_hash: Option<String>, service: Option<String>, criteria: Option<Vec<String>>,
    research:Option<research::Config>,context:Option<research::Context>,
}
#[derive(Deserialize)]
struct SourceInput { title: String, url: String, #[serde(default)] text: String }
#[derive(Serialize)]
struct Finding { claim: String, #[serde(rename="sourceId")] source_id: usize }
#[derive(Serialize)]
struct Source { id: usize, title: String, url: String, #[serde(rename="contentHash")] content_hash: String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Artifact { schema_version: u8, template: &'static str, question: String,
    findings: Vec<Finding>, sources: Vec<Source> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Output { schema_version: u8, job_id: u64, status: &'static str,
    output_hash: String, output_uri: String }

#[cfg(target_os="wasi")]
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Recall { schema_version:u8, job_id:u64, status:&'static str,
    output_hash:String, output_uri:String, summary:String }

fn hash(bytes: &[u8]) -> String { format!("sha256:{:x}",Sha256::digest(bytes)) }
fn words(s: &str) -> Vec<String> {
    const STOP: &[&str] = &["about","after","again","also","and","are","for","from","have","into","more","that","the","their","there","this","what","when","where","which","with"];
    let mut out=Vec::new(); let mut term=String::new();
    let push=|term:&mut String,out:&mut Vec<String>| {
        if term.len()>=3 && !STOP.contains(&term.as_str()) && !out.contains(term) {out.push(term.clone())}
        term.clear();
    };
    for c in s.chars() { if c.is_ascii_alphanumeric() {term.push(c.to_ascii_lowercase())} else {push(&mut term,&mut out)} }
    push(&mut term,&mut out); out
}
fn sentences(text: &str) -> Vec<String> {
    let chars:Vec<char>=text.chars().collect(); let mut parts=Vec::new(); let mut start=0;
    for i in 0..chars.len().saturating_sub(1) {
        if ".!?".contains(chars[i]) && chars[i+1].is_whitespace() {
            let mut j=i+1; while j<chars.len() && chars[j].is_whitespace(){j+=1}
            parts.push(chars[start..=i].iter().collect()); start=j;
        }
    }
    parts.push(chars[start..].iter().collect()); parts
}
fn normalize_spaces(text: &str) -> String { text.split_whitespace().collect::<Vec<_>>().join(" ") }

fn scout(input:&Input) -> Result<(Output,Artifact),String> {
    let question=input.question.as_ref().ok_or("Missing question")?;
    let sources=input.sources.as_ref().ok_or("Missing sources")?;
    if question.trim().len()<5 || question.len()>240 || sources.is_empty() || sources.len()>8 {return Err("Invalid Scout input".into())}
    let query=words(question);
    let mut source_list=Vec::new(); let mut candidates=Vec::new();
    for (ix,raw) in sources.iter().enumerate() {
        if raw.title.trim().is_empty() || raw.title.len()>120 || raw.text.len()<20 || raw.text.len()>50_000 {return Err("Invalid source".into())}
        let uri=url::Url::parse(&raw.url).map_err(|_|"Invalid source URL")?;
        if !(uri.scheme()=="http" || uri.scheme()=="https") || !uri.username().is_empty() || uri.password().is_some() {return Err("Invalid source URL".into())}
        let text=raw.text.trim(); let id=ix+1;
        source_list.push(Source{id,title:raw.title.trim().into(),url:uri.to_string(),content_hash:hash(text.as_bytes())});
        for (index,raw) in sentences(text).iter().enumerate() {
            let claim=normalize_spaces(raw.trim()); let terms=words(&claim);
            let overlap=query.iter().filter(|t|terms.contains(t)).count();
            let score=overlap*200+if claim.bytes().any(|b|b.is_ascii_digit()){40}else{0}+terms.len().min(20);
            if (30..=500).contains(&claim.len()) && overlap>0 {
                candidates.push((score,id,index,claim));
            }
        }
    }
    candidates.sort_by(|a,b|b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut findings=Vec::new(); let mut counts:HashMap<usize,usize>=HashMap::new(); let mut seen=HashSet::new();
    for (_,source_id,_,claim) in candidates {
        if findings.len()>=5 {break}
        if counts.get(&source_id).copied().unwrap_or(0)>=2 || !seen.insert(claim.clone()) {continue}
        *counts.entry(source_id).or_default()+=1;
        findings.push(Finding{claim,source_id});
    }
    if findings.is_empty(){return Err("No relevant supported findings".into())}
    let artifact=Artifact{schema_version:1,template:"scout@1.0.0",question:question.trim().into(),findings,sources:source_list};
    let bytes=serde_json::to_vec(&artifact).map_err(|e|e.to_string())?;
    let output_hash=hash(&bytes);
    let output=Output{schema_version:1,job_id:input.job_id,status:"ok",output_uri:format!("nfa://work/{}",&output_hash[7..]),output_hash};
    Ok((output,artifact))
}

// Compare measures evidence coverage, not whether an option is objectively better.
fn compare(input:&Input)->Result<(Output,serde_json::Value),String>{
    let question=input.question.as_ref().ok_or("Missing question")?;
    let criteria=input.criteria.as_ref().ok_or("Missing criteria")?;
    let sources=input.sources.as_ref().ok_or("Missing sources")?;
    if question.trim().len()<5 || question.len()>240 || criteria.is_empty() || criteria.len()>5
        || sources.len()<2 || sources.len()>8 {return Err("Invalid Compare input".into())}
    if criteria.iter().any(|c|c.trim().len()<3 || c.len()>60 || words(c).is_empty())
        || criteria.iter().collect::<HashSet<_>>().len()!=criteria.len(){return Err("Invalid criteria".into())}
    let mut ranking=Vec::new();
    for (index,source) in sources.iter().enumerate(){
        if source.title.trim().is_empty() || source.title.len()>120
            || source.text.len()<20 || source.text.len()>5000 {return Err("Invalid source".into())}
        let uri=url::Url::parse(&source.url).map_err(|_|"Invalid source URL")?;
        if !(uri.scheme()=="https" || uri.scheme()=="http") || !uri.username().is_empty()
            || uri.password().is_some(){return Err("Invalid source URL".into())}
        let mut evidence=Vec::new();
        for criterion in criteria {
            let terms=words(criterion);
            let candidate=sentences(source.text.trim()).into_iter().map(|s|normalize_spaces(&s))
                .find(|s|(30..=500).contains(&s.len()) && terms.iter().any(|term|words(s).contains(term)));
            if let Some(claim)=candidate {evidence.push(serde_json::json!({"criterion":criterion,"claim":claim}));}
        }
        ranking.push(serde_json::json!({"sourceId":index+1,"title":source.title.trim(),
            "url":uri.to_string(),"contentHash":hash(source.text.trim().as_bytes()),
            "matchedCriteria":evidence.len(),"evidence":evidence}));
    }
    if ranking.iter().all(|v|v["matchedCriteria"]==0){return Err("No relevant supported comparison".into())}
    ranking.sort_by(|a,b|b["matchedCriteria"].as_u64().cmp(&a["matchedCriteria"].as_u64())
        .then(a["sourceId"].as_u64().cmp(&b["sourceId"].as_u64())));
    let artifact=serde_json::json!({"schemaVersion":1,"template":"compare@1.0.0",
        "question":question.trim(),"criteria":criteria,"ranking":ranking});
    let output_hash=hash(&serde_json::to_vec(&artifact).map_err(|e|e.to_string())?);
    let output=Output{schema_version:1,job_id:input.job_id,status:"ok",
        output_uri:format!("nfa://work/{}",&output_hash[7..]),output_hash};
    Ok((output,artifact))
}

#[cfg(target_os="wasi")]
fn put_pending<T:Serialize>(service:&str,id:u64,output:&Output,artifact:&T)->Result<(),String>{
    use near::storage::api;
    let key=if service=="scout"{format!("pending:{id}")}else{format!("services/{service}/pending:{id}")};
    let value=serde_json::to_vec(&(output,artifact)).map_err(|e|e.to_string())?;
    let (inserted,error)=api::set_if_absent(&key,&value);
    if !error.is_empty(){return Err(error)}
    if !inserted {
        let (existing,error)=api::get(&key);
        if !error.is_empty() || existing!=value {return Err("Pending job already has a different result".into())}
    }
    Ok(())
}

#[cfg(target_os="wasi")]
fn recall(input:&Input)->Result<String,String>{
    use near::storage::api;
    let expected=input.expected_hash.as_ref().ok_or("Missing finalized commitment")?;
    let service=input.service.as_deref().unwrap_or("scout");
    if service!="scout" && service!="compare" && service!="research" {return Err("Unknown service".into())}
    let key=if service=="scout"{format!("pending:{}",input.job_id)}
        else{format!("services/{service}/pending:{}",input.job_id)};
    let (bytes,error)=api::get(&key);
    if !error.is_empty(){return Err(error)}
    let (output,artifact):(serde_json::Value,serde_json::Value)=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
    if output.get("outputHash").and_then(|x|x.as_str())!=Some(expected.as_str()) {
        return Err("Finalized commitment differs from stored memory".into())
    }
    let summary=artifact.get("findings").and_then(|f|f.get(0)).and_then(|f|f.get("claim"))
        .or_else(||artifact.get("ranking").and_then(|r|r.get(0)).and_then(|r|r.get("title")))
        .and_then(|x|x.as_str()).unwrap_or("").chars().take(220).collect();
    let result=Recall{schema_version:1,job_id:input.job_id,status:"ok",output_hash:expected.clone(),
        output_uri:output.get("outputUri").and_then(|x|x.as_str()).unwrap_or("").into(),summary};
    serde_json::to_string(&result).map_err(|e|e.to_string())
}

fn finish<T:Serialize>(input:&Input,service:&str,output:Output,artifact:T)->Result<String,String>{
    #[cfg(not(target_os="wasi"))] let _=&artifact;
    if let Some(expected)=&input.expected_hash {if expected!=&output.output_hash{return Err("Output commitment mismatch".into())}}
    #[cfg(target_os="wasi")]
    put_pending(service,input.job_id,&output,&artifact)?;
    #[cfg(not(target_os="wasi"))] let _=service;
    let text=serde_json::to_string(&output).map_err(|e|e.to_string())?;
    if text.len()>900{return Err("Output size cap".into())}
    Ok(text)
}
fn run(raw:&str)->Result<String,String>{
    if raw.len()>8192{return Err("Input size cap".into())}
    let input:Input=serde_json::from_str(raw).map_err(|e|e.to_string())?;
    if input.job_id==0{return Err("Job ID required".into())}
    if input.operation=="recall" {
        #[cfg(target_os="wasi")]
        return recall(&input);
        #[cfg(not(target_os="wasi"))]
        return Err("Recall requires OutLayer project storage".into());
    }
    if input.operation=="run"&&input.service.as_deref()==Some("research"){return research::run(&input)}
    let service=match(input.operation.as_str(),input.service.as_deref()){
        ("scout",None)|("run",Some("scout"))=>"scout",
        ("run",Some("compare"))=>"compare",
        _=>return Err("Typed service operation only".into())
    };
    if service=="scout"{let (output,artifact)=scout(&input)?;
        finish(&input,service,output,artifact)}
    else{let (output,artifact)=compare(&input)?;finish(&input,service,output,artifact)}
}
fn main(){
    let mut raw=String::new();
    let outcome=io::stdin().take(8193).read_to_string(&mut raw).map_err(|e|e.to_string()).and_then(|_|run(&raw));
    match outcome {Ok(value)=>println!("{value}"),Err(message)=>{
        // Validly dispatched Scout inputs can return a definite failure receipt.
        // A transport/OutLayer callback failure remains uncertain at the registry.
        let parsed=serde_json::from_str::<serde_json::Value>(&raw).ok();
        let id=parsed.as_ref().and_then(|v|v.get("jobId")).and_then(|v|v.as_u64());
        let operation=parsed.as_ref().and_then(|v|v.get("operation")).and_then(|v|v.as_str());
        if matches!(operation,Some("scout"|"run")) && id.unwrap_or(0)>0 {
            println!("{}",serde_json::json!({"schemaVersion":1,"jobId":id,"status":"failed"}));
        } else {eprintln!("Scout error: {message}");std::process::exit(1)}
    }}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_and_bounded(){
        let raw=r#"{"operation":"scout","jobId":3,"question":"How does a vault retain treasury?","sources":[{"title":"Vault","url":"https://example.org/vault","text":"A vault retains its treasury across NFT transfers. The vault account is unchanged when a different buyer owns the NFT and receives the authority to control it."}]}"#;
        let a=run(raw).unwrap(); let b=run(raw).unwrap();
        assert_eq!(a,b); assert!(a.contains("outputHash"));
        assert!(run("{}").is_err());
    }
    #[test]
    fn storage_wit_parses(){
        let mut resolve=wit_parser::Resolve::default();
        let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("wit");
        resolve.push_dir(&path).unwrap();
    }
    #[test]
    fn compare_is_deterministic_and_rejects_dynamic_operations(){
        let raw=r#"{"operation":"run","service":"compare","jobId":7,"question":"Which option has better evidence?","criteria":["cost","speed"],"sources":[{"title":"A","url":"https://example.org/a","text":"The cost of option A is five units for a single run. The speed of option A is two seconds per run."},{"title":"B","url":"https://example.org/b","text":"The cost of option B is seven units for a single run."}]}"#;
        assert_eq!(run(raw).unwrap(),run(raw).unwrap());
        assert!(run(raw).unwrap().contains("outputHash"));
        assert!(run(&raw.replace("\"compare\"","\"create_project\"")).is_err());
    }
}
