import { AGENTS } from "@/data/agents";
import { AgentLogo } from "@/design/AgentLogo";
import { SectionHead } from "./SectionHead";
import styles from "./Agents.module.css";

export function Agents() {
  return (
    <section id="agents">
      <div className="wrap">
        <SectionHead
          eyebrow={{ label: "Agents", href: "#faq" }}
          title="Anything with a skills folder."
        >
          gandalf finds the agents you have installed and keeps each folder in step with your
          library. Point any agent at a folder of your own.
        </SectionHead>
        <div className={styles.agents}>
          {AGENTS.map((agent) => {
            const parent = agent.dir.slice(0, agent.dir.lastIndexOf("/") + 1);
            const leaf = agent.dir.slice(parent.length);
            return (
              <div key={agent.id} className={styles.agent}>
                <AgentLogo agent={agent} size={32} className={styles.logo} />
                <b className={styles.name}>{agent.name}</b>
                <span className={`gd-path ${styles.path}`}>
                  {parent}
                  <b>{leaf}</b>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
