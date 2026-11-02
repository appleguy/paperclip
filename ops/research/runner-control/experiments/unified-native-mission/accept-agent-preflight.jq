# An assignment can be admitted only after lifecycle setup/resume has settled.
# status=idle alone is insufficient: a manually resumed agent may still be pausing.
.id == $id
and .adapterType == "opencode_local"
and .lifecycleState == "ready"
and .lifecycleHolds == []
and (.status != "paused" and .status != "terminated" and .status != "pending_approval")
and .runtimeConfig.heartbeat.wakeOnAssignment == true
