use std::path::PathBuf;

use crate::event_processor::CodexStatus;
use crate::event_processor::EventProcessor;
use crate::event_processor::handle_last_message;
use codex_core::config::Config;
use codex_core::protocol::Event;
use codex_core::protocol::EventMsg;
use codex_core::protocol::SessionConfiguredEvent;
use codex_core::protocol::TaskCompleteEvent;
use tracing::error;

/// Sink that receives serialized protocol events.
pub trait ProtocolEventWriter: Send {
    fn write_line(&mut self, line: &str);
}

/// Default writer that forwards events to stdout as JSONL.
pub struct StdoutProtocolEventWriter;

impl ProtocolEventWriter for StdoutProtocolEventWriter {
    #[allow(clippy::print_stdout)]
    fn write_line(&mut self, line: &str) {
        println!("{line}");
    }
}

pub struct EventProcessorWithJsonEventOutput<W: ProtocolEventWriter = StdoutProtocolEventWriter> {
    last_message_path: Option<PathBuf>,
    writer: W,
}

impl EventProcessorWithJsonEventOutput<StdoutProtocolEventWriter> {
    pub fn new(last_message_path: Option<PathBuf>) -> Self {
        Self::with_writer(StdoutProtocolEventWriter, last_message_path)
    }
}

impl<W: ProtocolEventWriter> EventProcessorWithJsonEventOutput<W> {
    pub fn with_writer(writer: W, last_message_path: Option<PathBuf>) -> Self {
        Self {
            last_message_path,
            writer,
        }
    }

    fn emit_event(&mut self, event: &Event) {
        match serde_json::to_string(event) {
            Ok(line) => self.writer.write_line(&line),
            Err(e) => error!("Failed to serialize protocol event: {e:?}"),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn into_inner(self) -> W {
        self.writer
    }
}

impl<W> EventProcessor for EventProcessorWithJsonEventOutput<W>
where
    W: ProtocolEventWriter + 'static,
{
    fn print_config_summary(
        &mut self,
        _config: &Config,
        _prompt: &str,
        session_configured: &SessionConfiguredEvent,
    ) {
        let event = Event {
            id: String::new(),
            msg: EventMsg::SessionConfigured(session_configured.clone()),
        };
        self.emit_event(&event);
    }

    fn process_event(&mut self, event: Event) -> CodexStatus {
        let status = match &event.msg {
            EventMsg::TaskComplete(TaskCompleteEvent { last_agent_message }) => {
                if let Some(output_file) = self.last_message_path.as_deref() {
                    handle_last_message(last_agent_message.as_deref(), output_file);
                }
                CodexStatus::InitiateShutdown
            }
            EventMsg::ShutdownComplete => CodexStatus::Shutdown,
            _ => CodexStatus::Running,
        };

        self.emit_event(&event);

        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_processor::EventProcessor;
    use codex_core::config::Config;
    use codex_core::config::ConfigOverrides;
    use codex_core::config::ConfigToml;
    use codex_core::protocol::Event;
    use codex_core::protocol::EventMsg;
    use codex_core::protocol::SessionConfiguredEvent;
    use codex_core::protocol::TaskCompleteEvent;
    use codex_protocol::ConversationId;
    use pretty_assertions::assert_eq;
    use serde_json::Value;
    use std::path::PathBuf;
    use tempfile::NamedTempFile;
    use tempfile::TempDir;

    #[derive(Default)]
    struct TestWriter {
        lines: Vec<String>,
    }

    impl ProtocolEventWriter for TestWriter {
        fn write_line(&mut self, line: &str) {
            self.lines.push(line.to_string());
        }
    }

    fn build_test_config() -> Config {
        let codex_home = TempDir::new().expect("tempdir");
        Config::load_from_base_config_with_overrides(
            ConfigToml::default(),
            ConfigOverrides::default(),
            codex_home.path().to_path_buf(),
        )
        .expect("config")
    }

    fn session_configured_event() -> SessionConfiguredEvent {
        let session_id =
            ConversationId::from_string("67e55044-10b1-426f-9247-bb680e5fe0c8").unwrap();
        SessionConfiguredEvent {
            session_id,
            model: "gpt-test".to_string(),
            reasoning_effort: None,
            history_log_id: 42,
            history_entry_count: 1,
            initial_messages: None,
            rollout_path: PathBuf::from("/tmp/rollout.json"),
        }
    }

    #[test]
    fn print_config_summary_emits_session_configured_event() {
        let config = build_test_config();
        let mut processor =
            EventProcessorWithJsonEventOutput::with_writer(TestWriter::default(), None);
        let event = session_configured_event();

        EventProcessor::print_config_summary(&mut processor, &config, "hello", &event);

        let writer = processor.into_inner();
        assert_eq!(writer.lines.len(), 1);
        let value: Value = serde_json::from_str(&writer.lines[0]).expect("json");
        assert_eq!(value["id"], "");
        assert_eq!(
            value["msg"]["session_id"],
            serde_json::json!("67e55044-10b1-426f-9247-bb680e5fe0c8")
        );
        assert_eq!(value["msg"]["model"], "gpt-test");
    }

    #[test]
    fn task_complete_writes_last_message_and_emits_event() {
        let tmp = NamedTempFile::new().expect("tempfile");
        let path = tmp.path().to_path_buf();
        let mut processor = EventProcessorWithJsonEventOutput::with_writer(
            TestWriter::default(),
            Some(path.clone()),
        );

        let event = Event {
            id: "evt-1".to_string(),
            msg: EventMsg::TaskComplete(TaskCompleteEvent {
                last_agent_message: Some("done".to_string()),
            }),
        };

        let status = EventProcessor::process_event(&mut processor, event);

        let writer = processor.into_inner();
        assert_eq!(writer.lines.len(), 1);
        let value: Value = serde_json::from_str(&writer.lines[0]).expect("json");
        assert_eq!(value["id"], "evt-1");
        assert_eq!(value["msg"]["last_agent_message"], "done");

        let file_contents = std::fs::read_to_string(path).expect("read");
        assert_eq!(file_contents, "done");
        assert!(matches!(status, CodexStatus::InitiateShutdown));
    }
}
