//! The session JSON verbs: start, stop and resume.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

#[derive(Deserialize)]
pub(super) struct SessionRequest {
    /// `None`/empty = whatever the daemon is already configured with.
    profile: Option<String>,
}

/// POST /api/session/stop — "Pause emulation & map".
pub(super) async fn api_session_stop(State(state): State<Arc<AppState>>) -> Response {
    control_json(state, |control| match control.stop() {
        Ok(message) => serde_json::json!({
            "ok": true,
            "message": consumer_map_detail(&message, "Play is paused. You can edit controls now.")
        }),
        Err(refusal) => serde_json::json!({
            "ok": false,
            "error": consumer_map_detail(
                &refusal.message,
                "Play could not be paused. Nothing changed."
            )
        }),
    })
    .await
}

/// POST /api/session/resume — **"Resume emulation".**
///
/// One `ControlSource::resume`, with no body at all. What it puts back is the
/// daemon's to decide (`ksx_api::SessionOrigin`): the mapper had been sending
/// `start` with the games.toml profile it remembered at pause time, which is
/// `None` for a session played from an unsaved staged setup — and `start`
/// means the config on disk, so the setup that was playing was neither
/// restarted nor mentioned. A refusal comes back as the daemon's own sentence,
/// which says what is missing and that nothing was written.
pub(super) async fn api_session_resume(State(state): State<Arc<AppState>>) -> Response {
    control_json(state, |control| match control.resume() {
        Ok(message) => serde_json::json!({ "ok": true, "message": message }),
        Err(refusal) => serde_json::json!({ "ok": false, "error": refusal.message }),
    })
    .await
}

/// POST /api/session/start — start emulation from the config on disk,
/// optionally under a games.toml profile. **Not the mapper's Resume**; see
/// [`api_session_resume`].
pub(super) async fn api_session_start(
    State(state): State<Arc<AppState>>,
    axum::Json(request): axum::Json<SessionRequest>,
) -> Response {
    let profile = request
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned);
    control_json(state, move |control| {
        match control.start(profile.as_deref()) {
            Ok(message) => serde_json::json!({
                "ok": true,
                "message": consumer_map_detail(&message, "Play resumed.")
            }),
            Err(refusal) => serde_json::json!({
                "ok": false,
                "error": consumer_map_detail(
                    &refusal.message,
                    "Play could not resume. Open Home and press Play when you are ready."
                )
            }),
        }
    })
    .await
}
