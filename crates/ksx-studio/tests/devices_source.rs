//! Authored-source contracts for the Devices certificate-cleanup control.
//!
//! The generated asset test proves today's bundle. These checks pin the TS/CSS
//! that produces the next bundle, including the expensive-reconcile exception
//! that a normal two-second poll intentionally cannot cover.

const ISLAND: &str = include_str!("../../../studio-ui/src/DevicesIsland.ts");
const ENTRY: &str = include_str!("../../../studio-ui/src/devices.ts");
const CSS: &str = include_str!("../../../studio-ui/src/studio.css");

#[test]
fn certificate_cleanup_is_one_confirmed_post_with_no_identity_fields() {
    assert_eq!(
        ISLAND
            .matches(r#"action: "/devices/certificates/sweep""#)
            .count(),
        1,
        "the actionable sweep form must exist exactly once"
    );
    assert!(ISLAND.contains(r#"method: "post""#));
    assert!(ISLAND.contains(r#"name: "confirm""#));
    assert!(ISLAND.contains(r#"required: """#));
    assert!(ISLAND.contains("Any certificate still signing an installed driver stays in place"));
    for field in [
        r#"name: "subject""#,
        r#"name: "thumbprint""#,
        r#"name: "store""#,
        r#"name: "path""#,
    ] {
        assert!(
            !ISLAND.contains(field),
            "certificate identity must be backend-owned, found {field}"
        );
    }
}

// DELETED 2026-08-26: `zero_and_blocked_states_cannot_render_the_actionable_form`
// (TAUTOLOGICAL). Its load-bearing line restated the island's own boolean
// expression back at itself:
//
//     assert!(ISLAND.contains(
//         "!residue.readable || leftoverCertificates > 0 || certificatesUnknown !== \"\""));
//
// A test that quotes the implementation can detect CHANGE but never
// WRONGNESS: invert the condition in both places and it still agrees, and any
// harmless reordering of the `||` breaks it for no reason.
//
// The behaviour it was standing in for is now pinned where it can actually
// fail — `render_devices.rs::the_certificate_sweep_renders_the_state_the_residue_supports`
// renders the page in all four residue states and asserts which control comes
// out, including the one that matters: a store that could not be READ must
// never be offered a destructive certificate delete. The sweep state is
// server-injected (`show:certificateSweepReady` / `show:certificateSweepBlocked`),
// so the SSR pass is a real oracle for it.

#[test]
fn certificate_only_residue_survives_hydration_and_refreshes_after_mutation() {
    assert!(ISLAND.contains("leftoverCertificates > 0"));
    assert!(ISLAND.contains("certificatesUnknown !== \"\""));
    assert!(ISLAND.contains("certificatesLine !== \"\""));
    assert!(ENTRY.contains(r#"new URL(form.action).pathname === "/devices/certificates/sweep""#));
    assert!(ENTRY.contains("window.location.assign(res.url)"));
    assert!(ENTRY.contains("const pendingForms = new WeakSet<HTMLFormElement>()"));
    assert!(CSS.contains(".dv-sweep"));
}
