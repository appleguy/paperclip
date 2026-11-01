use paperclip_runner_core::antigravity_provider::{
    AntigravityBinding, AntigravityDispatchExecutor,
};
use paperclip_runner_core::durable::{Command, CommandExecutor};
use serde_json::{json, Value};
fn command(kind: &str, id: &str, payload: Value) -> Command {
    Command {
        schema: "paperclip.prp.command.v3".into(),
        command_id: id.into(),
        controller_seq: 1,
        command_type: kind.into(),
        issued_at: "fixture".into(),
        deadline_at: None,
        precondition: None,
        payload,
    }
}
fn binding() -> AntigravityBinding {
    AntigravityBinding {
        binding_id: "b".into(),
        binding_generation: 1,
        run_id: "r".into(),
        environment_lease_id: "lease".into(),
        session_id: "s".into(),
        turn_id: "t".into(),
        conversation_id: "native".into(),
        process_generation: "g".into(),
        start_command_id: "start".into(),
    }
}
#[test]
fn durable_single_turn_native_result_is_not_paperclip_completion() {
    let dir = std::path::PathBuf::from(format!(
        "/Volumes/NVM/AI_Agent_Runtime/tmp/agy-rust-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let test = || {
        let mut e = AntigravityDispatchExecutor::open(&dir, binding()).unwrap();
        assert!(e
            .execute(&command("turn.start", "start", json!({"text":"hello"})))
            .is_err());
        let provider = json!({"kind":"antigravity_headless","conversationId":"native","processGeneration":"g","bindingId":"b","bindingGeneration":1,"startCommandId":"start","controllerCapability":"antigravity-headless-dispatch.v1"});
        e.execute(&command(
            "run.prepare",
            "prepare",
            json!({"provider":provider}),
        ))
        .unwrap();
        e.execute(&command("session.open", "open", json!({})))
            .unwrap();
        let result = e
            .execute(&command("turn.start", "start", json!({"text":"hello"})))
            .unwrap();
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].0, "native_controller.dispatch_requested");
        drop(e);
        let mut e = AntigravityDispatchExecutor::open(&dir, binding()).unwrap();
        assert_eq!(
            e.execute(&command("turn.start", "start", json!({"text":"hello"})))
                .unwrap()
                .events
                .len(),
            1
        );
        assert!(e
            .execute(&command("turn.start", "start", json!({"text":"changed"})))
            .is_err());
        let mut result = json!({"action":"antigravity.native_result","bindingId":"b","bindingGeneration":1,"runId":"r","environmentLeaseId":"lease","normalizedSessionId":"s","turnId":"t","conversationId":"native","processGeneration":"g","dispatchEventId":"event","result":{"status":"SUCCESS","response":"answer"}});
        result["conversationId"] = json!("foreign");
        assert!(e
            .execute(&command(
                "native_controller.observation",
                "result",
                result.clone()
            ))
            .is_err());
        result["conversationId"] = json!("native");
        let observed = e
            .execute(&command("native_controller.observation", "result", result))
            .unwrap();
        assert_eq!(observed.result["paperclipCompletion"], "unverified");
        assert_eq!(observed.events[0].0, "harness.diagnostic");
        drop(e);
        let mut e = AntigravityDispatchExecutor::open(&dir, binding()).unwrap();
        assert!(e
            .execute(&command("turn.start", "start", json!({"text":"hello"})))
            .is_err());
        assert!(e.shutdown().is_err());
        let mut exit = json!({"action":"antigravity.provider_exit","bindingId":"b","bindingGeneration":1,"runId":"r","environmentLeaseId":"lease","normalizedSessionId":"s","turnId":"t","conversationId":"native","processGeneration":"g","exitObserved":false});
        assert!(e
            .execute(&command(
                "native_controller.observation",
                "exit",
                exit.clone()
            ))
            .is_err());
        exit["exitObserved"] = json!(true);
        assert_eq!(
            e.execute(&command("native_controller.observation", "exit", exit))
                .unwrap()
                .result["providerExitConfirmed"],
            true
        );
        assert!(e.shutdown().is_ok());
    };
    test();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn runner_selector_recovers_only_matching_lease() {
    use paperclip_runner_core::durable::DurableRunnerConfig;
    use paperclip_runner_core::native_provider_backend::NativeProviderCommandExecutor;
    use std::time::Duration;
    let dir = std::path::PathBuf::from(format!(
        "/Volumes/NVM/AI_Agent_Runtime/tmp/agy-select-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let config = DurableRunnerConfig {
        connect_url: "ws://127.0.0.1/runner".into(),
        ca_bundle_path: None,
        state_dir: dir.clone(),
        runner_instance_id: "runner".into(),
        environment_lease_id: "lease".into(),
        run_id: "r".into(),
        normalized_session_id: "s".into(),
        turn_id: "t".into(),
        item_id: "item".into(),
        runner_version: "0.0.0".into(),
        runner_digest: "sha256:test".into(),
        acpx_launch_profile: None,
        opencode_launch_profile: None,
        max_outbox_bytes: 1024 * 1024,
        p0_reserve_bytes: 64 * 1024,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::from_secs(60),
    };
    let provider = json!({"kind":"antigravity_headless","conversationId":"native","processGeneration":"g","bindingId":"b","bindingGeneration":1,"startCommandId":"start","controllerCapability":"antigravity-headless-dispatch.v1"});
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&dir, &config);
    let mut unsupported = provider.clone();
    unsupported["controllerCapability"] = json!("unknown.v1");
    assert!(executor
        .execute(&command(
            "run.prepare",
            "unsupported",
            json!({"provider":unsupported})
        ))
        .is_err());
    executor
        .execute(&command(
            "run.prepare",
            "prepare",
            json!({"provider":provider}),
        ))
        .unwrap();
    executor
        .execute(&command("session.open", "open", json!({})))
        .unwrap();
    assert_eq!(
        executor
            .execute(&command("turn.start", "start", json!({"text":"hello"})))
            .unwrap()
            .events
            .len(),
        1
    );
    drop(executor);
    let mut recovered = NativeProviderCommandExecutor::with_runner_config(&dir, &config);
    assert_eq!(
        recovered
            .execute(&command("session.snapshot", "snapshot", json!({})))
            .unwrap()
            .result["status"],
        "offered"
    );
    let mut foreign = config.clone();
    foreign.environment_lease_id = "foreign".into();
    assert!(
        NativeProviderCommandExecutor::with_runner_config(&dir, &foreign)
            .execute(&command("session.snapshot", "snapshot", json!({})))
            .is_err()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn native_observation_requires_v2_protocol() {
    let mut request = command("native_controller.observation", "result", json!({}));
    request.schema = "paperclip.prp.command.v1".into();
    assert!(request.validate().is_err());
    request.schema = "paperclip.prp.command.v2".into();
    assert!(request.validate().is_ok());
}
