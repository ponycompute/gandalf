import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { saveAppearance, savedAppearance, type Appearance } from "../appearance";
import { Button } from "../design/Button";
import { PathText } from "../design/PathText";
import { SegmentedControl } from "../design/SegmentedControl";
import { invoke } from "../invoke";
import type { Names } from "../vocabulary";
import { SettingRow, SettingsGroup, SettingsPage } from "./SettingsGroup";

const APPEARANCE_SEGMENTS = [
  {
    value: "system",
    label: "System",
    icon: <HugeiconsIcon icon={ComputerIcon} size={14} aria-hidden />,
  },
  {
    value: "light",
    label: "Light",
    icon: <HugeiconsIcon icon={Sun03Icon} size={14} aria-hidden />,
  },
  { value: "dark", label: "Dark", icon: <HugeiconsIcon icon={Moon02Icon} size={14} aria-hidden /> },
] as const satisfies readonly { readonly value: Appearance; readonly label: string }[];

/** Puts the appearance the user chose last on the window; System leaves the Mac's in place. */
export function applySavedAppearance(): void {
  const appearance = savedAppearance(window.localStorage);
  if (appearance !== "system") void invoke(() => window.gandalf.setAppearance(appearance));
}

function errorText(error: { readonly message?: string }): string {
  return error.message === undefined ? "" : `: ${error.message}`;
}

/** Settings' General section: where the library lives, and the window's appearance. */
export function General({ names }: { readonly names: Names }) {
  const [appearance, setAppearance] = useState(() => savedAppearance(window.localStorage));
  const [error, setError] = useState<string | null>(null);

  const choose = async (next: Appearance) => {
    setAppearance(next);
    saveAppearance(window.localStorage, next);
    const result = await invoke(() => window.gandalf.setAppearance(next));
    setError(
      result.ok ? null : `gandalf could not change the appearance${errorText(result.error)}.`,
    );
  };
  const reveal = async () => {
    const result = await invoke(() => window.gandalf.revealLibrary());
    setError(result.ok ? null : `gandalf could not show the library${errorText(result.error)}.`);
  };

  return (
    <SettingsPage>
      <SettingsGroup title="Library">
        <SettingRow label="Library folder" hint={<PathText path={names.libraryDir} />}>
          <Button size="small" onClick={() => void reveal()}>
            Show in Finder
          </Button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="App">
        <SettingRow label="Appearance" hint="System follows your Mac's light or dark setting.">
          <SegmentedControl<Appearance>
            label="Appearance"
            segments={APPEARANCE_SEGMENTS}
            value={appearance}
            onChange={(next) => void choose(next)}
          />
        </SettingRow>
      </SettingsGroup>
      {error === null ? null : (
        <p role="alert" className="text-callout text-status-conflict select-text">
          {error}
        </p>
      )}
    </SettingsPage>
  );
}
