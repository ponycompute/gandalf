import styles from "./Intro.module.css";

export function Intro() {
  return (
    <div className={`wrap ${styles.intro}`}>
      <p>
        <b>Your agents start every session from zero.</b> You explain the release steps to Claude
        Code on Monday, to Codex on Wednesday, to Cursor on Friday. Skills fix that, if someone
        writes them and keeps 14 folders in step. gandalf does both.
      </p>
    </div>
  );
}
