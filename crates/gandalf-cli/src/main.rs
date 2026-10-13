use clap::Parser;
use gandalf_cli::commands::style::Palette;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match gandalf_cli::run(gandalf_cli::args::Cli::parse()).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            let palette = Palette::stderr();
            eprintln!("{} {error}", palette.bad("error:"));
            if let Some(hint) = error.hint() {
                eprintln!("{}", palette.dim(hint));
            }
            std::process::ExitCode::from(error.exit_code())
        }
    }
}
