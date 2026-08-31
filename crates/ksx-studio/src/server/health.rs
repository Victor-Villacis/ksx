//! Product-independent Studio health and provenance.
//!
//! The managed real-hardware and fixture lanes must prove more than "a TCP
//! listener answered": the response has to come from the expected provider,
//! the daemon's staged channel has to answer where required, and the process
//! has to have opened the expected configuration root.  Those are operational
//! facts, not properties of either `/redesign` or a legacy product document,
//! so they live behind one small stable endpoint of their own.

use super::*;

const SETUP_READ_ERROR: &str = "Configuration could not be read. Reopen ksx and try again.";

/// Collect one coherent automation snapshot off the async workers.
///
/// Environment provenance is immutable for the life of a provider.  The two
/// mutable reads happen together on one blocking task so a launch gate never
/// combines daemon reachability from one HTTP response with a config root from
/// another.
pub(super) async fn collect_health(state: &Arc<AppState>) -> StudioHealthPayload {
    let health_state = Arc::clone(state);
    let environment = state.source.environment();
    let fallback_environment = environment.clone();
    tokio::task::spawn_blocking(move || {
        let staged = health_state.control.staged();
        let (setup, setup_error) = match health_state
            .machine_cache
            .setup_state(&*health_state.machine)
        {
            Ok(setup) => (
                Some(StudioHealthSetup {
                    config_root: setup.config_root,
                }),
                String::new(),
            ),
            Err(_) => (None, SETUP_READ_ERROR.to_owned()),
        };
        StudioHealthPayload {
            environment,
            staged: StudioHealthStaged {
                reachable: staged.reachable,
                error: staged.error,
            },
            setup,
            setup_error,
        }
    })
    .await
    .unwrap_or_else(|_| StudioHealthPayload {
        environment: fallback_environment,
        staged: StudioHealthStaged {
            reachable: false,
            error: Some("the Studio health collection panicked".to_owned()),
        },
        setup: None,
        setup_error: SETUP_READ_ERROR.to_owned(),
    })
}

/// Stable, guarded, never-cached health contract for launchers and lane tools.
pub(super) async fn api_health(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_health(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}
