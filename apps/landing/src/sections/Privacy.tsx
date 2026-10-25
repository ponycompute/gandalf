import { SectionHead } from "./SectionHead";
import styles from "./Privacy.module.css";

const FACTS = [
  {
    lead: "Local by default",
    text: "The timeline stays on your Mac, in files you can read, move and delete.",
  },
  {
    lead: "You choose what it sees",
    text: "Exclude apps and sites, set how long captures are kept, and pause from the menu bar.",
  },
  {
    lead: "Nothing installs on its own",
    text: "A draft becomes a skill only when you approve it, and every link is shown before it is made.",
  },
  {
    lead: "Your skills stay yours",
    text: "A skill you placed by hand is shown as Not managed. gandalf never replaces it; you can adopt it when you want.",
  },
];

export function Privacy() {
  return (
    <section id="privacy">
      <div className="wrap">
        <SectionHead
          eyebrow={{ label: "Privacy and control", href: "#faq" }}
          title="Built to sit on your Mac, not in your way."
        />
        <div className={styles.facts}>
          {FACTS.map((fact) => (
            <div key={fact.lead} className={styles.fact}>
              <b>{fact.lead}</b>
              {fact.text}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
