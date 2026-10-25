import { Brand } from "@/design/Brand";
import { GITHUB_URL } from "@/data/links";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer>
      <div className={`wrap ${styles.bar}`}>
        <a href="#" aria-label="Gandalf home">
          <Brand size={36} />
        </a>
        <nav className={styles.links} aria-label="Footer">
          <a href={GITHUB_URL}>GitHub</a>
          <a href="#privacy">Privacy</a>
          <a href="#faq">FAQ</a>
        </nav>
      </div>
    </footer>
  );
}
