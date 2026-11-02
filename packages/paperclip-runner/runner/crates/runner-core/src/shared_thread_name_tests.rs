use super::*;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::time::Duration;

fn naming_bootstrap(response: &str) {
    let root = PathBuf::from(format!("/Volumes/NVM/AI_Agent_Runtime/tmp/n-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.join("s");
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let meta = fs::symlink_metadata(&path).unwrap();
    let generation = format!("{}:{}:{}:{}", meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec());
    let cwd = root.to_string_lossy().to_string();
    let server_cwd = cwd.clone();
    let response = response.to_owned();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        for method in ["initialize", "initialized", "thread/start", "thread/name/set"] {
            let request: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(request["method"], method);
            if method == "initialized" { continue; }
            if method == "thread/name/set" {
                assert_eq!(request["params"], json!({"threadId":"thread", "name":"Issue · Agent"}));
                if response == "timeout" { std::thread::sleep(Duration::from_secs(17)); return; }
            }
            let reply = match method {
                "thread/start" => json!({"id":request["id"], "result":{"thread":{"id":"thread", "cwd":server_cwd}, "model":"model", "reasoningEffort":"high"}}),
                "thread/name/set" if response == "error" => json!({"id":request["id"], "error":{"code":-32601,"message":"unsupported"}}),
                _ => json!({"id":request["id"], "result":{}}),
            };
            ws.send(tungstenite::Message::Text(reply.to_string().into())).unwrap();
        }
    });
    let mut provider = json!({"provider":"codex","driver":"codex_app_server","providerVersion":"test","command":"/not/executed","cwd":cwd,"model":"model","instructions":"Work","approvalPolicy":"never","readOnly":true,"sharedDaemon":{"socketPath":path,"daemonGeneration":generation,"threadId":"","threadName":"Issue · Agent","codexHome":root,"peer":current_test_peer(),"bootstrapId":"bootstrap","writer":{"runId":"run","normalizedSessionId":"session","runnerInstanceId":"runner","grantId":"grant","epoch":1,"observationEpochId":"observation","managedTools":true,"managedBootstrapId":"bootstrap","reasoningEffort":"high"}}});
    provider["sharedDaemon"]["writer"]["threadConfig"] = json!({"permissions": {
        "paperclip-runner-workspace-only": {"filesystem":{":root":"none",":minimal":"read",":tmpdir":"none",":workspace_roots":{".":"write"}},"network":{"enabled":false}},
        "paperclip-runner-workspace-read-only": {"filesystem":{":root":"none",":minimal":"read",":tmpdir":"none",":workspace_roots":{".":"read"}},"network":{"enabled":false}}
    }, "web_search":"disabled", "shell_environment_policy":{"inherit":"none"}});
    let mut executor = CodexCommandExecutor::new(root.join("state"));
    executor.event_identity = Some(ProviderEventIdentity { runner_instance_id:"runner".into(), run_id:"run".into(), normalized_session_id:"session".into(), turn_id:"turn".into(), item_id:"item".into() });
    let result = executor.prepare(&json!({"provider":provider})).expect("cosmetic naming must not fail bootstrap");
    assert_eq!(result.result["providerSessionId"], "thread");
    assert_eq!(executor.state.as_ref().unwrap().shared_bootstrap.as_ref().unwrap()["state"], "created");
    drop(executor);
    server.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test] fn naming_success_does_not_fail_bootstrap() { naming_bootstrap("success"); }
#[test] fn naming_rejection_does_not_fail_bootstrap() { naming_bootstrap("error"); }
#[test] fn naming_timeout_does_not_fail_bootstrap() { naming_bootstrap("timeout"); }
