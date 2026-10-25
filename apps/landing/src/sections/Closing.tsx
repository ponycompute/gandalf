import { GITHUB_URL } from "@/data/links";
import { Logo } from "@/design/Brand";
import styles from "./Closing.module.css";

export function Closing() {
  return (
    <div className={styles.closing}>
      <Logo size={96} className={styles.logo} />
      <h2>Write it down once.</h2>
      <p>The library is ready now. Capture and drafts are next.</p>
      <a className="btn btn-primary" href={GITHUB_URL}>
        View on GitHub
      </a>
    </div>
  );
}
