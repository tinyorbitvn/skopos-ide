/**
 * True when text is selected and the selection starts or ends inside `row`. A click on a
 * row's toggle then ends a drag that selected its text: the user meant to select, not to
 * open or close the row.
 */
export function endsSelection(row: Element | null | undefined): boolean {
  if (!row) return false;
  const selection = row.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || selection.toString() === "")
    return false;
  return (
    row.contains(selection.anchorNode) || row.contains(selection.focusNode)
  );
}
