/** What dialog.showOpenDialog resolves, as far as chooseFolder reads it. */
export interface OpenDialogAnswer {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

/** The folder the user chose, or null when they cancelled or the panel returned no usable path. */
export function chosenFolder(answer: OpenDialogAnswer): string | null {
  const [path] = answer.filePaths;
  return answer.canceled || path === undefined || !path.startsWith("/") ? null : path;
}
