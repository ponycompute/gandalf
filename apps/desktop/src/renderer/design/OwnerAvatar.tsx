import { useEffect, useState } from "react";
import { invoke } from "../invoke";

/** Avatars already fetched, kept for the session so scrolling and switching boards asks once. */
const avatars = new Map<string, Promise<string | null>>();

function avatarOf(owner: string): Promise<string | null> {
  let found = avatars.get(owner);
  if (found === undefined) {
    found = invoke(() => window.gandalf.ownerAvatar(owner)).then((result) =>
      result.ok ? result.value : null,
    );
    avatars.set(owner, found);
  }
  return found;
}

/** The GitHub owner's avatar, or the owner's first letter until it arrives or when there is none. */
export function OwnerAvatar({
  owner,
  fallback,
  size = "size-7",
}: {
  readonly owner: string | null;
  /** Its first letter shows until the avatar arrives, or when there is none. */
  readonly fallback: string;
  readonly size?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (owner === null) return;
    let current = true;
    void avatarOf(owner).then((found) => {
      if (current) setUrl(found);
    });
    return () => {
      current = false;
    };
  }, [owner]);
  return url === null ? (
    <span
      aria-hidden
      className={`grid ${size} flex-none place-items-center rounded-md bg-separator text-callout font-semibold text-label-secondary uppercase`}
    >
      {fallback.charAt(0)}
    </span>
  ) : (
    <img src={url} alt="" className={`${size} flex-none rounded-md`} />
  );
}
