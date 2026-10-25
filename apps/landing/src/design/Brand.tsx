import Image from "next/image";
import type { CSSProperties } from "react";
import styles from "./Brand.module.css";

/**
 * The mark with the name beside it in plain type. The mark keeps its built-in margin (design system
 * Logo rules), so it is drawn larger than the type and pulled in by that margin.
 */
export function Brand({ size = 48 }: { size?: number }) {
  return (
    <span className={styles.brand} style={{ "--mark": `${size}px` } as CSSProperties}>
      <Logo size={size} className={styles.mark} />
      Gandalf
    </span>
  );
}

/** gandalf-logo.svg on light grounds, gandalf-logo-dark.svg on dark ones. */
export function Logo({ size, className = "" }: { size: number; className?: string }) {
  return (
    <>
      <Image
        className={`${className} logo-light`}
        src="/gandalf-logo.svg"
        alt=""
        width={size}
        height={size}
        priority
      />
      <Image
        className={`${className} logo-dark`}
        src="/gandalf-logo-dark.svg"
        alt=""
        width={size}
        height={size}
        priority
      />
    </>
  );
}
