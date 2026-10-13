use clap::Parser;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match gandalf_cli::run(gandalf_cli::args::Cli::parse()).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::from(error.exit_code())
        }
    }
}
