//! `gandalf skill test`: measures whether a skill helps, using the user's
//! own Claude Code read-only.

use std::{
    fmt::Write as _,
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
};

use gandalf_distill::{
    ClaudeCode, ClaudeCodeRunner, Evaluation, Problem, evaluate, generate_problems, stage_skill,
};
use gandalf_skills::ENTRYPOINT;
use serde::Serialize;

use crate::{
    CliError,
    args::Output,
    commands::style::{Palette, count},
};

/// Options for `gandalf skill test`.
#[derive(Clone, Debug)]
pub struct TestOptions {
    pub problems: usize,
    /// Only write the problems and rubrics; run nothing.
    pub dry_run: bool,
    /// Dollar ceiling for each answering run.
    pub max_budget_usd: f64,
}

/// The file written beside `SKILL.md` after a test.
const RESULT_FILE: &str = "evaluation.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DryRunOutput {
    dry_run: bool,
    skill: String,
    problems: Vec<Problem>,
}

/// Runs the effect test for the skill at `path` inside `project_root`.
///
/// # Errors
///
/// Returns a CLI error when the skill cannot be read, the agent fails, or
/// output cannot be written.
pub fn test(
    output: Output,
    project_root: &Path,
    path: &Path,
    options: &TestOptions,
) -> Result<(), CliError> {
    let palette = Palette::stdout();
    let (name, skill_md) = read_skill(path)?;
    let agent = ClaudeCode::default();
    let problems = generate_problems(&agent, &skill_md, options.problems.max(1))?;

    if options.dry_run {
        return match output {
            Output::Json => json(&DryRunOutput {
                dry_run: true,
                skill: name,
                problems,
            }),
            Output::Text => write_out(&render_problems(palette, &name, &problems)),
        };
    }

    if output == Output::Text {
        write_out(&render_problems(palette, &name, &problems))?;
        write_out(&format!(
            "\nRunning each problem twice with Claude Code, read-only ({} runs)…\n",
            problems.len() * 2
        ))?;
    }
    let (_stage, extra_dir) = stage_skill(path, &name)?;
    let runner = ClaudeCodeRunner {
        executable: None,
        max_budget_usd: options.max_budget_usd,
    };
    let evaluation = evaluate(
        &runner,
        &agent,
        project_root,
        &extra_dir,
        &name,
        &problems,
        |index, arm| {
            if output == Output::Text {
                let _ = write_out(&format!("  problem {} {arm}\n", index + 1));
            }
        },
    )?;
    let saved = save(path, &evaluation);
    match output {
        Output::Json => json(&evaluation),
        Output::Text => write_out(&render_evaluation(palette, &evaluation, saved.as_deref())),
    }
}

fn read_skill(path: &Path) -> Result<(String, String), CliError> {
    let entry = path.join(ENTRYPOINT);
    let skill_md = fs::read_to_string(&entry).map_err(|error| {
        CliError::Distill(gandalf_distill::DistillError::Io {
            context: format!("read {}", entry.display()),
            source: error,
        })
    })?;
    let name = path.file_name().map_or_else(
        || "skill".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    Ok((name, skill_md))
}

fn save(path: &Path, evaluation: &Evaluation) -> Option<PathBuf> {
    let target = path.join(RESULT_FILE);
    let encoded = serde_json::to_vec_pretty(evaluation).ok()?;
    fs::write(&target, encoded).ok()?;
    Some(target)
}

fn render_problems(palette: Palette, name: &str, problems: &[Problem]) -> String {
    let mut text = format!(
        "{} for {}\n",
        palette.bold(&count(problems.len(), "problem")),
        palette.bold(name)
    );
    for (index, problem) in problems.iter().enumerate() {
        let _ = writeln!(
            text,
            "\n{} {}",
            palette.dim(&format!("{}.", index + 1)),
            problem.request
        );
        for item in &problem.rubric {
            let _ = writeln!(text, "   {} {item}", palette.dim("·"));
        }
    }
    text
}

fn render_evaluation(palette: Palette, evaluation: &Evaluation, saved: Option<&Path>) -> String {
    let totals = evaluation.totals();
    let mut text = format!(
        "\n{}\n\n",
        palette.bold(&format!("Effect of {}", evaluation.skill))
    );
    let rows = [
        (
            "rubric",
            format!("{}/{}", totals.with_score, totals.rubric_items),
            format!("{}/{}", totals.without_score, totals.rubric_items),
        ),
        (
            "tool calls",
            totals.with_tool_calls.to_string(),
            totals.without_tool_calls.to_string(),
        ),
        (
            "time",
            seconds(totals.with_duration_ms),
            seconds(totals.without_duration_ms),
        ),
    ];
    let _ = writeln!(
        text,
        "{:<12}{:>12}{:>12}",
        "",
        palette.bold("with skill"),
        palette.bold("without")
    );
    for (label, with, without) in rows {
        let _ = writeln!(text, "{label:<12}{with:>12}{without:>12}");
    }
    let _ = writeln!(
        text,
        "\nSkill used in {} of {} runs.",
        totals.skill_used,
        evaluation.results.len()
    );
    let verdict = if totals.skill_used == 0 {
        palette.warn(
            "The agent never loaded the skill: its description probably does not match the problems. Make the description more concrete.",
        )
    } else if totals.with_score > totals.without_score {
        palette.good("The skill helps: more rubric points with fewer steps.")
    } else if totals.with_tool_calls < totals.without_tool_calls {
        palette.good("Same answers, reached with fewer steps.")
    } else {
        palette.warn("No measurable effect on these problems.")
    };
    let _ = writeln!(text, "{verdict}");

    for (index, result) in evaluation.results.iter().enumerate() {
        let _ = writeln!(
            text,
            "\n{} {}",
            palette.dim(&format!("{}.", index + 1)),
            result.problem.request.lines().next().unwrap_or_default()
        );
        let _ = writeln!(
            text,
            "   with {}/{}  without {}/{}",
            result.with_grade.score(),
            result.problem.rubric.len(),
            result.without_grade.score(),
            result.problem.rubric.len()
        );
        for point in &result.without_grade.useful_points_beyond_rubric {
            let _ = writeln!(
                text,
                "   {} {point}",
                palette.dim("without, beyond rubric:")
            );
        }
        for claim in &result.with_grade.unsupported_claims {
            let _ = writeln!(
                text,
                "   {} {claim}",
                palette.warn("unsupported with skill:")
            );
        }
    }
    let _ = writeln!(
        text,
        "\nCost ${:.2}{}",
        evaluation.total_cost(),
        saved.map_or_else(String::new, |path| palette
            .dim(&format!(" · saved to {}", path.display())))
    );
    text
}

fn seconds(ms: u64) -> String {
    format!("{}s", ms.div_ceil(1000))
}

fn json<T: Serialize>(value: &T) -> Result<(), CliError> {
    let encoded = serde_json::to_vec(value).map_err(|_| CliError::Output)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&encoded).map_err(|_| CliError::Output)?;
    stdout.write_all(b"\n").map_err(|_| CliError::Output)
}

fn write_out(text: &str) -> Result<(), CliError> {
    io::stdout()
        .lock()
        .write_all(text.as_bytes())
        .map_err(|_| CliError::Output)
}
