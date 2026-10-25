import type { AppError } from "../shared/ipc";
import { Banner } from "./design/Banner";
import { PathText } from "./design/PathText";

export function ErrorBanner({ error }: { readonly error: AppError }) {
  switch (error.kind) {
    case "stateCorrupt":
      return (
        <Banner tone="error" title="gandalf cannot read its state file">
          <PathText path={error.path} />
          <span className="select-text">{error.reason}</span>
          <span>
            Fix the file or move it aside, then reopen gandalf. Until then gandalf changes no skills
            or agent folders.
          </span>
        </Banner>
      );
    case "git":
      return (
        <Banner tone="error" title="A git command failed">
          <span className="select-text">{error.message}</span>
          <span>Some changes may already be applied. Click Sync to see what is left.</span>
        </Banner>
      );
    case "badInput":
      return (
        <Banner tone="error" title="gandalf rejected the request">
          <span className="select-text">{error.message}</span>
          <span>Nothing changed. Try again. If it happens again, report the message above.</span>
        </Banner>
      );
    case "internal":
      return (
        <Banner tone="error" title="gandalf hit an unexpected error">
          <span className="select-text">{error.message}</span>
          <span>Quit and reopen gandalf. If it happens again, report the message above.</span>
        </Banner>
      );
  }
}
