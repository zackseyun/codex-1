use crate::protocol::v2::CommandAction;
use codex_protocol::protocol::GuardianAssessmentAction;
use codex_protocol::protocol::GuardianAssessmentEvent;
use codex_shell_command::parse_command::parse_command;
use codex_shell_command::parse_command::shlex_join;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq)]
pub struct GuardianCommandExecutionProjection {
    pub command: String,
    pub cwd: PathBuf,
    pub command_actions: Vec<CommandAction>,
}

pub fn guardian_command_execution_projection(
    assessment: &GuardianAssessmentEvent,
) -> Option<GuardianCommandExecutionProjection> {
    match &assessment.action {
        GuardianAssessmentAction::Command { command, cwd, .. } => {
            let command = command.clone();
            let command_actions = vec![CommandAction::Unknown {
                command: command.clone(),
            }];
            Some(GuardianCommandExecutionProjection {
                command,
                cwd: cwd.clone(),
                command_actions,
            })
        }
        GuardianAssessmentAction::Execve {
            program, argv, cwd, ..
        } => {
            let argv = if argv.is_empty() {
                vec![program.clone()]
            } else {
                std::iter::once(program.clone())
                    .chain(argv.iter().skip(1).cloned())
                    .collect::<Vec<_>>()
            };
            let command = shlex_join(&argv);
            let parsed_cmd = parse_command(&argv);
            let command_actions = if parsed_cmd.is_empty() {
                vec![CommandAction::Unknown {
                    command: command.clone(),
                }]
            } else {
                parsed_cmd.into_iter().map(CommandAction::from).collect()
            };
            Some(GuardianCommandExecutionProjection {
                command,
                cwd: cwd.clone(),
                command_actions,
            })
        }
        _ => None,
    }
}
