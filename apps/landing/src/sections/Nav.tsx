import { Brand } from "@/design/Brand";
import { GITHUB_URL } from "@/data/links";
import styles from "./Nav.module.css";

export function Nav() {
  return (
    <header className={styles.nav}>
      <div className={`wrap ${styles.bar}`}>
        <a className={styles.home} href="#" aria-label="Gandalf home">
          <Brand size={48} />
        </a>
        <nav className={styles.links} aria-label="Sections">
          <a href="#how">How It Works</a>
          <a href="#agents">Agents</a>
          <a href="#privacy">Privacy</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className={styles.right}>
          <a className="btn btn-primary btn-small" href={GITHUB_URL}>
            View on GitHub
          </a>
        </div>
      </div>
    </header>
  );
}
