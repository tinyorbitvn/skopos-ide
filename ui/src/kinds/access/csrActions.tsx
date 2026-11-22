import { toast } from "../../design";
import { BadgeCheck, CircleX } from "../../design/icons";
import { api } from "../../ipc/api";
import type { KindAction } from "../registry";
import { ApproveBody } from "./CsrDetail";
import { isPending } from "./csr";

// No `requires`: approval is a subresource with its own signer check, and the API server
// answers for it, as for TokenRequest.
export const approveCsrAction: KindAction = {
  id: "csr-approve",
  label: "Approve",
  icon: BadgeCheck,
  top: true,
  visible: isPending,
  run: async (ctx, o) => {
    const name = o.metadata.name;
    // One read for the confirm, and the approval is bound to its uid: a request deleted and
    // made again under the same name is not approved.
    const review = await api.csrReview(ctx.clusterId, name);
    const ok = await ctx.confirm({
      title: `Approve certificate request ${name}?`,
      body: <ApproveBody review={review} />,
      confirmLabel: "Approve",
      danger: review.privileged.length > 0,
    });
    if (!ok) return;
    await api.csrSetApproval(ctx.clusterId, name, review.uid, "Approve");
    toast.success(`Approved ${name}`);
  },
};

export const denyCsrAction: KindAction = {
  id: "csr-deny",
  label: "Deny",
  icon: CircleX,
  danger: true,
  top: true,
  visible: isPending,
  run: async (ctx, o) => {
    const name = o.metadata.name;
    const ok = await ctx.confirm({
      title: `Deny certificate request ${name}?`,
      body: "The requester gets no certificate. Kubernetes deletes the request an hour later.",
      confirmLabel: "Deny",
      danger: true,
    });
    if (!ok) return;
    await api.csrSetApproval(ctx.clusterId, name, o.metadata.uid ?? "", "Deny");
    toast.success(`Denied ${name}`);
  },
};

export const CSR_ACTIONS: KindAction[] = [approveCsrAction, denyCsrAction];
