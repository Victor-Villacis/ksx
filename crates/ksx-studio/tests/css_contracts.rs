//! Static contracts for the authored Studio styles.
//!
//! A bare `var(--name)` has no CSS fallback: when `--name` is misspelled or
//! removed, the browser silently discards the declaration that contains it.
//! The redesign is compact enough to enforce that every such reference is
//! either declared in the shipped stylesheets or written by its runtime.

use std::collections::BTreeSet;

const TOKENS_CSS: &str = include_str!("../../../studio-ui/src/tokens.gen.css");
const CANVAS_CSS: &str = include_str!("../../../studio-ui/src/genui-canvas.css");
const STUDIO_CSS: &str = include_str!("../../../studio-ui/src/studio.css");
const REDESIGN_RUNTIME: &str = include_str!("../../../studio-ui/src/RedesignIsland.ts");
const REDESIGN_MARKER: &str = "/* ═══ REDESIGN WORKBENCH";

#[derive(Debug, PartialEq, Eq)]
struct CustomPropertyReference {
    name: String,
    line: usize,
}

/// Remove block comments while preserving newlines for useful diagnostics.
fn strip_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'/' && bytes.get(at + 1) == Some(&b'*') {
            let end = source[at + 2..]
                .find("*/")
                .map_or(source.len(), |offset| at + 2 + offset + 2);
            for byte in &bytes[at..end] {
                if *byte == b'\n' {
                    out.push('\n');
                }
            }
            at = end;
        } else {
            let ch = source[at..]
                .chars()
                .next()
                .expect("byte offset remains on a character boundary");
            out.push(ch);
            at += ch.len_utf8();
        }
    }
    out
}

fn is_custom_property_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn custom_property_definitions(source: &str) -> BTreeSet<String> {
    let clean = strip_comments(source);
    let bytes = clean.as_bytes();
    let mut definitions = BTreeSet::new();
    let mut at = 0;

    while at + 2 <= bytes.len() {
        let Some(offset) = clean[at..].find("--") else {
            break;
        };
        let start = at + offset;
        let mut end = start + 2;
        while end < bytes.len() && is_custom_property_byte(bytes[end]) {
            end += 1;
        }
        let mut next = end;
        while next < bytes.len() && bytes[next].is_ascii_whitespace() {
            next += 1;
        }
        if end > start + 2 && bytes.get(next) == Some(&b':') {
            definitions.insert(clean[start..end].to_owned());
        }
        at = end.max(start + 2);
    }

    definitions
}

/// Literal `style.setProperty("--name", ...)` calls are runtime definitions.
/// Keeping this tied to the redesign source means deleting the writer makes
/// the CSS contract fail instead of leaving an unearned allowlist entry.
fn runtime_custom_property_definitions(source: &str) -> BTreeSet<String> {
    let mut definitions = BTreeSet::new();
    let mut rest = source;

    while let Some(offset) = rest.find("setProperty(") {
        rest = &rest[offset + "setProperty(".len()..];
        let trimmed = rest.trim_start();
        let Some(quote) = trimmed.as_bytes().first().copied() else {
            break;
        };
        if !matches!(quote, b'\'' | b'"') {
            continue;
        }
        let value = &trimmed[1..];
        let Some(end) = value.find(char::from(quote)) else {
            continue;
        };
        let name = &value[..end];
        if name.starts_with("--")
            && name.as_bytes()[2..]
                .iter()
                .all(|b| is_custom_property_byte(*b))
        {
            definitions.insert(name.to_owned());
        }
    }

    definitions
}

/// Find only bare references. `var(--optional, fallback)` is intentionally
/// valid without a declaration, while `var(--required)` is not.
fn bare_custom_property_references(
    source: &str,
    first_line: usize,
) -> Vec<CustomPropertyReference> {
    let clean = strip_comments(source);
    let bytes = clean.as_bytes();
    let mut references = Vec::new();
    let mut at = 0;

    while at < bytes.len() {
        let Some(offset) = clean[at..].find("var(") else {
            break;
        };
        let call = at + offset;
        let mut name_start = call + "var(".len();
        while name_start < bytes.len() && bytes[name_start].is_ascii_whitespace() {
            name_start += 1;
        }
        if !clean[name_start..].starts_with("--") {
            at = name_start.max(call + 1);
            continue;
        }
        let mut name_end = name_start + 2;
        while name_end < bytes.len() && is_custom_property_byte(bytes[name_end]) {
            name_end += 1;
        }
        let mut next = name_end;
        while next < bytes.len() && bytes[next].is_ascii_whitespace() {
            next += 1;
        }
        if bytes.get(next) == Some(&b')') {
            references.push(CustomPropertyReference {
                name: clean[name_start..name_end].to_owned(),
                line: first_line + clean[..call].bytes().filter(|byte| *byte == b'\n').count(),
            });
        }
        // Advance only past this call's prefix so nested var() fallbacks are
        // inspected independently on the next iteration.
        at = name_start.max(call + 1);
    }

    references
}

#[test]
fn redesign_has_no_undefined_bare_custom_property_references() {
    let mut definitions = custom_property_definitions(TOKENS_CSS);
    definitions.extend(custom_property_definitions(CANVAS_CSS));
    definitions.extend(custom_property_definitions(STUDIO_CSS));
    definitions.extend(runtime_custom_property_definitions(REDESIGN_RUNTIME));

    let redesign_at = STUDIO_CSS
        .find(REDESIGN_MARKER)
        .expect("studio.css must retain the redesign section marker");
    let first_line = 1 + STUDIO_CSS[..redesign_at]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count();
    let missing: Vec<_> = bare_custom_property_references(&STUDIO_CSS[redesign_at..], first_line)
        .into_iter()
        .filter(|reference| !definitions.contains(&reference.name))
        .collect();

    assert!(
        missing.is_empty(),
        "undefined bare custom-property reference(s) in redesign CSS:\n  {}\n\
         Declare the property, use the intended design token, provide a CSS fallback, or add a real runtime writer.",
        missing
            .iter()
            .map(|reference| format!("studio.css:{} {}", reference.line, reference.name))
            .collect::<Vec<_>>()
            .join("\n  ")
    );
}

#[test]
fn bare_reference_reader_ignores_explicit_fallbacks() {
    let references = bare_custom_property_references(
        ".example { color: var(--required); background: var(--optional, red); }",
        7,
    );
    assert_eq!(
        references,
        vec![CustomPropertyReference {
            name: "--required".to_owned(),
            line: 7,
        }]
    );
}
