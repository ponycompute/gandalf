import { GITHUB_URL } from "@/data/links";
import { Dither } from "@/design/Dither";
import { AppWindow } from "./AppWindow";
import styles from "./Hero.module.css";

export function Hero() {
  return (
    <div className={styles.hero}>
      <Dither />
      <h1 className={styles.title}>
        The skill library that writes itself, linked into every coding agent.
      </h1>
      <p className={styles.sub}>
        gandalf notices the work you repeat, drafts it as a skill, and links it into Claude Code,
        Codex, Cursor and 10 more agents once you approve it.
      </p>
      <div className={styles.cta}>
        <a className="btn btn-primary" href={GITHUB_URL}>
          View on GitHub
        </a>
        <a className="btn" href="#how">
          How It Works
        </a>
      </div>
      <div className={styles.shot}>
        <AppWindow />
      </div>
    </div>
  );
}
