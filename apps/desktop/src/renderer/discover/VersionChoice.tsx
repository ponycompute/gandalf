import { useEffect, useId, useState } from "react";
import type { AdoptPick, AdoptVariant, NotDone } from "@gandalf/skills";
import { Button } from "../design/Button";
import { PathText } from "../design/PathText";
import { invoke } from "../invoke";
import type { Names } from "../vocabulary";
import { DiffView, shortHash } from "./DiffView";
import { readKey, readsFor, type Read, type StoredReads } from "./reads";

type NeedsChoice = Extract<NotDone, { kind: "needsChoice" }>;

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** Who holds a version: the agents that write to its folders, or the folders themselves. */
export function variantLabel(variant: AdoptVariant, names: Names): string {
  return AND.format([...new Set(variant.at.map((at) => names.folder(at.root)))]);
}

/** "Adopt Claude Code's Version", or "Adopt the Version in ~/.agents/skills" for a bare folder. */
export function pickLabel(label: string): string {
  return label.startsWith("~") || label.startsWith("/")
    ? `Adopt the Version in ${label}`
    : `Adopt ${label}'s Version`;
}

/**
 * Each variant's SKILL.md, read through main, which serves only files in skill folders it shows.
 * Read again whenever a hash changes too, since a plan made after a rewrite keeps the same paths.
 */
function useSkillFiles(variants: readonly AdoptVariant[]): readonly Read[] {
  const [stored, setStored] = useState<StoredReads | null>(null);
  const key = readKey(variants);
  useEffect(() => {
    let current = true;
    const paths = (JSON.parse(key) as [string, string][]).map(([, path]) => path);
    void Promise.all(
      paths.map((path) =>
        invoke(() => window.gandalf.readSkillFile(`${path}/SKILL.md`)).then((result): Read => ({
          kind: "read",
          text: result.ok ? result.value : null,
        })),
      ),
    ).then((reads) => {
      if (current) setStored({ key, reads });
    });
    return () => {
      current = false;
    };
  }, [key]);
  return readsFor(stored, key, variants.length);
}

function Unreadable() {
  return (
    <p className="text-callout text-label-secondary">
      gandalf cannot read this SKILL.md, so it cannot show how the versions differ.
    </p>
  );
}

interface VersionChoiceProps {
  readonly item: NeedsChoice;
  readonly names: Names;
  /** True while a pick is being planned, so a second one cannot race it. */
  readonly disabled: boolean;
  readonly onPick: (pick: AdoptPick) => void;
}

/**
 * The versions of one name that differ between agents. Each one after the first shows a diff of
 * its SKILL.md against the first, and the choice is made with the button under it.
 */
export function VersionChoice({ item, names, disabled, onPick }: VersionChoiceProps) {
  const heading = useId();
  const reads = useSkillFiles(item.variants);
  const [first] = item.variants;
  const firstRead = reads[0];
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 px-5 pb-3">
      <div className="flex flex-col gap-0.5">
        <h3 id={heading} className="text-title-3">
          Choose the version of {item.name} to adopt
        </h3>
        <p className="text-callout text-label-secondary">
          The copies of {item.name} differ. gandalf moves the one you choose into the library and
          links the agents whose copy matches it. The other copies stay where they are.
        </p>
      </div>
      {item.variants.map((variant, index) => {
        const label = variantLabel(variant, names);
        const read = reads[index];
        return (
          <div
            key={variant.hash}
            data-variant={variant.hash}
            className="flex flex-col gap-2 border-t border-separator pt-3"
          >
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold">
                {label} ·{" "}
                <span className="font-mono text-path font-normal">{shortHash(variant.hash)}</span>
              </span>
              {variant.at.map((at) => (
                <PathText key={at.path} path={at.path} />
              ))}
            </div>
            {index === 0 || first === undefined ? null : read?.kind !== "read" ||
              firstRead?.kind !== "read" ? (
              <p className="text-callout text-label-secondary">Reading SKILL.md…</p>
            ) : read.text === null || firstRead.text === null ? (
              <Unreadable />
            ) : (
              <DiffView
                before={{
                  label: variantLabel(first, names),
                  hash: first.hash,
                  text: firstRead.text,
                }}
                after={{ label, hash: variant.hash, text: read.text }}
              />
            )}
            <div className="flex justify-end">
              <Button
                disabled={disabled}
                onClick={() => onPick({ name: item.name, kind: "hash", hash: variant.hash })}
              >
                {pickLabel(label)}
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
