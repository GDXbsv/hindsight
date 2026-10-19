//! Session commands: live conversations streamed into a bank, and the memory watcher's side of them.
//!
//! `events --follow` tails a session as it happens: what the client sends, and Hindsight's checks,
//! notes and saves, one line each.

use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::api::ApiClient;
use crate::output::{self, OutputFormat};
use crate::ui;

const FOLLOW_EVERY: Duration = Duration::from_secs(1);

fn clip(s: &str, n: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > n {
        format!("{}…", one_line.chars().take(n).collect::<String>())
    } else {
        one_line
    }
}

fn text(p: &Value, key: &str) -> String {
    p.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// One log entry as one line: who, what, and the gist.
pub(crate) fn entry_line(entry: &Value) -> String {
    let seq = entry.get("seq").and_then(Value::as_i64).unwrap_or_default();
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = entry
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let p = entry.get("payload").cloned().unwrap_or(Value::Null);
    let role = text(&p, "role");
    let body = match (source, kind) {
        ("client", "message") => format!("{}: {}", role, clip(&text(&p, "text"), 160)),
        ("client", "tool_call") => {
            let input = p.get("input").cloned().unwrap_or(Value::Null);
            let target = ["file_path", "command", "path", "pattern", "query", "url"]
                .iter()
                .find_map(|k| input.get(*k).and_then(Value::as_str))
                .unwrap_or_default();
            format!("{} {}", text(&p, "tool"), clip(target, 120))
        }
        ("client", "tool_result") => {
            let failed = p.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            format!(
                "{}{}",
                if failed { "failed: " } else { "→ " },
                clip(&text(&p, "text"), 120)
            )
        }
        ("client", "state") => "the work so far (state)".to_string(),
        ("client", "turn_end") => "turn ended".to_string(),
        ("hindsight", "check") => {
            let outcome = text(&p, "outcome");
            let ms = p.get("ms").and_then(Value::as_i64).unwrap_or_default();
            let path = p
                .get("llm_calls")
                .and_then(Value::as_array)
                .and_then(|calls| calls.first())
                .and_then(|c| c.get("detail"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let why = text(&p, "reason");
            format!(
                "checked the {}: {}{} {}",
                text(&p, "trigger"),
                outcome,
                if ms > 0 {
                    format!(" in {ms}ms")
                } else {
                    String::new()
                },
                clip(if why.is_empty() { path } else { &why }, 100)
            )
        }
        ("hindsight", "note") => format!("NOTE: {}", text(&p, "text")),
        ("hindsight", "save") => format!(
            "saved #{}..#{} into {}",
            p.get("from_seq")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                + 1,
            p.get("to_seq").and_then(Value::as_i64).unwrap_or_default(),
            text(&p, "document_id")
        ),
        _ => format!("{kind} {}", clip(&p.to_string(), 120)),
    };
    let who = if source == "hindsight" {
        ui::gradient_text("hindsight")
    } else {
        ui::dim(source)
    };
    format!("{} {} {}", ui::dim(&format!("#{seq:<4}")), who, body)
}

pub fn list(
    client: &ApiClient,
    bank_id: &str,
    query: Option<String>,
    limit: i64,
    offset: u64,
    output_format: OutputFormat,
) -> Result<()> {
    let result = client.list_sessions(bank_id, query.as_deref(), limit, offset)?;
    if output_format != OutputFormat::Pretty {
        return output::print_output(&result, output_format);
    }
    ui::print_section_header(&format!("Sessions: {}", bank_id));
    let v = serde_json::to_value(&result)?;
    let items = v
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        println!("  {}", ui::dim("No sessions."));
    }
    for s in &items {
        let title = s
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_else(|| s["session_id"].as_str().unwrap_or(""));
        println!(
            "  {} {} {}",
            s["session_id"].as_str().unwrap_or_default(),
            ui::dim(&format!("[{}]", s["status"].as_str().unwrap_or_default())),
            clip(title, 60)
        );
        println!(
            "    {}",
            ui::dim(&format!(
                "{} events · {} checks · {} notes ({} delivered) · updated {}",
                s["event_count"],
                s["check_count"],
                s["note_count"],
                s["delivered_count"],
                s["updated_at"].as_str().unwrap_or_default()
            ))
        );
    }
    println!();
    println!("  {} {} total", ui::dim("Total:"), v["total"]);
    Ok(())
}

pub fn get(
    client: &ApiClient,
    bank_id: &str,
    session_id: &str,
    output_format: OutputFormat,
) -> Result<()> {
    let result = client.get_session(bank_id, session_id)?;
    output::print_output(
        &result,
        if output_format == OutputFormat::Pretty {
            OutputFormat::Yaml
        } else {
            output_format
        },
    )
}

/// The events to send: from a JSON file (an array of events), or one event from the flags.
pub struct EventArgs {
    pub events_file: Option<String>,
    pub id: Option<String>,
    pub role: String,
    pub kind: String,
    pub text: Option<String>,
    pub tool: Option<String>,
    pub call_id: Option<String>,
}

pub struct SessionArgs {
    pub watch: bool,
    pub retain: Option<String>,
    pub title: Option<String>,
}

fn events_of(a: &EventArgs) -> Result<Vec<Value>> {
    if let Some(path) = &a.events_file {
        let raw = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
        let events: Vec<Value> =
            serde_json::from_str(&raw).context("the events file must be a JSON array of events")?;
        return Ok(events);
    }
    if a.text.is_none() && a.tool.is_none() && a.kind == "message" {
        return Ok(vec![]); // nothing to send: fetch notes
    }
    // Without an id a retry would store the event again; with the clock, two calls never collide.
    let id = a.id.clone().unwrap_or_else(|| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        format!("cli-{}", now.as_nanos())
    });
    let mut e = json!({"id": id, "role": a.role, "kind": a.kind});
    if let Some(t) = &a.text {
        e["text"] = json!(t);
    }
    if let Some(t) = &a.tool {
        e["tool"] = json!(t);
    }
    if let Some(c) = &a.call_id {
        e["call_id"] = json!(c);
    }
    Ok(vec![e])
}

pub fn append(
    client: &ApiClient,
    bank_id: &str,
    session_id: &str,
    events: EventArgs,
    session: SessionArgs,
    ack: Option<u64>,
    output_format: OutputFormat,
) -> Result<()> {
    let mut body = json!({"events": events_of(&events)?});
    if let Some(a) = ack {
        body["ack"] = json!(a);
    }
    if session.watch || session.retain.is_some() || session.title.is_some() {
        let mut opts = json!({});
        if session.watch {
            opts["watch"] = json!(true);
        }
        if let Some(r) = &session.retain {
            opts["retain"] = json!(r);
        }
        if let Some(t) = &session.title {
            opts["title"] = json!(t);
        }
        body["session"] = opts;
    }
    let result = client.append_session_events(bank_id, session_id, body)?;
    if output_format != OutputFormat::Pretty {
        return output::print_output(&result, output_format);
    }
    let v = serde_json::to_value(&result)?;
    ui::print_success(&format!(
        "{} stored, {} already there; the log is at #{}{}",
        v["accepted"],
        v["duplicates"],
        v["last_seq"],
        if v["checking"].as_bool().unwrap_or(false) {
            " (Hindsight is checking)"
        } else {
            ""
        }
    ));
    for n in v["notes"].as_array().cloned().unwrap_or_default() {
        println!(
            "  {} {}",
            ui::gradient_text(&format!("note #{}", n["seq"])),
            n["text"].as_str().unwrap_or_default()
        );
    }
    Ok(())
}

pub fn events(
    client: &ApiClient,
    bank_id: &str,
    session_id: &str,
    after: u64,
    limit: u64,
    follow: bool,
    output_format: OutputFormat,
) -> Result<()> {
    let mut after = after;
    loop {
        let result = client.list_session_events(bank_id, session_id, after, limit)?;
        let v = serde_json::to_value(&result)?;
        if output_format != OutputFormat::Pretty && !follow {
            return output::print_output(&result, output_format);
        }
        let items = v["items"].as_array().cloned().unwrap_or_default();
        for entry in &items {
            if output_format == OutputFormat::Pretty {
                println!("{}", entry_line(entry));
            } else {
                println!("{}", serde_json::to_string(entry)?); // one JSON object per line while following
            }
            after = entry["seq"].as_u64().unwrap_or(after);
        }
        let caught_up = (items.len() as u64) < limit;
        if !follow {
            if caught_up {
                return Ok(());
            }
            continue;
        }
        if caught_up
            && v["status"].as_str() == Some("closed")
            && !v["checking"].as_bool().unwrap_or(false)
        {
            return Ok(());
        }
        if caught_up {
            std::thread::sleep(FOLLOW_EVERY);
        }
    }
}

pub fn close(
    client: &ApiClient,
    bank_id: &str,
    session_id: &str,
    output_format: OutputFormat,
) -> Result<()> {
    let result = client.close_session(bank_id, session_id)?;
    if output_format == OutputFormat::Pretty {
        ui::print_success(&format!("Session '{}' closed", session_id));
        Ok(())
    } else {
        output::print_output(&result, output_format)
    }
}

pub fn delete(
    client: &ApiClient,
    bank_id: &str,
    session_id: &str,
    output_format: OutputFormat,
) -> Result<()> {
    let result = client.delete_session(bank_id, session_id)?;
    if output_format == OutputFormat::Pretty {
        ui::print_success(&format!("Session '{}' deleted", session_id));
        Ok(())
    } else {
        output::print_output(&result, output_format)
    }
}

#[cfg(test)]
mod tests {
    use super::{entry_line, events_of, EventArgs};
    use serde_json::json;

    fn plain(s: String) -> String {
        // Strip ANSI colours so the assertions read the words.
        let mut out = String::new();
        let mut esc = false;
        for c in s.chars() {
            match (esc, c) {
                (false, '\u{1b}') => esc = true,
                (true, 'm') => esc = false,
                (true, _) => {}
                (false, c) => out.push(c),
            }
        }
        out
    }

    #[test]
    fn a_note_and_a_check_read_as_one_line_each() {
        let note = json!({"seq": 7, "source": "hindsight", "kind": "note", "payload": {"text": "K is 1024."}});
        assert!(plain(entry_line(&note)).ends_with("NOTE: K is 1024."));
        let check = json!({"seq": 6, "source": "hindsight", "kind": "check", "payload": {
            "trigger": "edit", "outcome": "silent", "ms": 1200,
            "llm_calls": [{"scope": "decision_pick", "detail": "none=0.97"}]}});
        assert!(plain(entry_line(&check)).contains("checked the edit: silent in 1200ms none=0.97"));
        let call = json!({"seq": 2, "source": "client", "kind": "tool_call",
            "payload": {"role": "assistant", "tool": "Edit", "input": {"file_path": "a.py"}}});
        assert!(plain(entry_line(&call)).ends_with("Edit a.py"));
    }

    #[test]
    fn one_event_from_the_flags_or_none_to_fetch_notes() {
        let args = |text: Option<&str>| EventArgs {
            events_file: None,
            id: Some("e1".into()),
            role: "user".into(),
            kind: "message".into(),
            text: text.map(str::to_string),
            tool: None,
            call_id: None,
        };
        assert_eq!(
            events_of(&args(Some("hi"))).unwrap(),
            vec![json!({"id": "e1", "role": "user", "kind": "message", "text": "hi"})]
        );
        assert!(events_of(&args(None)).unwrap().is_empty());
    }
}
