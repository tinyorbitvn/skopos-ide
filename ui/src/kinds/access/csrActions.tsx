import { toast } from "../../design";
import { BadgeCheck, CircleX } from "../../design/icons";
import { api } from "../../ipc/api";
import type { KindAction } from "../registry";
import { ApproveBody } from "./CsrDetail";
import { describeRequest, isPending } from "./csr";

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
    const info = await describeRequest(o);
    const ok = await ctx.confirm({
      title: `Approve certificate request ${name}?`,
      body: <ApproveBody object={o} info={info} />,
      confirmLabel: "Approve",
      danger: info.organizations.some((g) => g.startsWith("system:")),
    });
    if (!ok) return;
    await api.csrSetApproval(ctx.clusterId, name, "Approve");
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
    await api.csrSetApproval(ctx.clusterId, name, "Deny");
    toast.success(`Denied ${name}`);
  },
};

export const CSR_ACTIONS: KindAction[] = [approveCsrAction, denyCsrAction];
