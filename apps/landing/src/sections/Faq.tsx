import { SectionHead } from "./SectionHead";
import styles from "./Faq.module.css";

export const QUESTIONS = [
  {
    question: "What is a skill?",
    answer:
      "A folder with a SKILL.md that tells an agent how to do one job your way: your release steps, your review checklist, your migration rules. Agents load the ones that fit the task.",
  },
  {
    question: "Do I need capture to use gandalf?",
    answer:
      "No. Library, adopt, install and sync work on their own today. Capture is something you turn on when it ships.",
  },
  {
    question: "What happens to skills I already have?",
    answer:
      "They show up in Discover as Not managed. gandalf leaves them where they are until you adopt them. When two agents hold different copies of the same skill, you pick the version to keep.",
  },
  {
    question: "My agent is not on the list.",
    answer: "Point gandalf at its skills folder and it is kept in step like the others.",
  },
  {
    question: "Which platforms?",
    answer: "The app is for macOS 26 and later. The CLI runs anywhere Node 22 runs.",
  },
];

export function Faq() {
  return (
    <section id="faq">
      <div className="wrap">
        <SectionHead title="Questions" />
        <div className={styles.faq}>
          {QUESTIONS.map((item) => (
            <details key={item.question} className={styles.item}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
