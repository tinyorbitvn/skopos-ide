import { createElement } from "react";
import { Maximize2 } from "../../design/icons";
import type { KindAction } from "../registry";
import { ResizeDialog } from "./ResizeDialog";

/** Asks for a larger size on a PersistentVolumeClaim; the dialog says when it cannot grow. */
export const resizeAction: KindAction = {
  id: "resize",
  label: "Resize",
  icon: Maximize2,
  requires: "patch",
  run: (ctx, o) =>
    ctx.dialog((close) =>
      createElement(ResizeDialog, {
        clusterId: ctx.clusterId,
        object: o,
        close,
      }),
    ),
};
