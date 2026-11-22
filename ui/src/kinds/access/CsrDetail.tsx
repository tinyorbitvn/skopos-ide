import { useEffect, useState } from "react";
import type { CertificateRequestInfo } from "../../ipc/generated/CertificateRequestInfo";
import { Facts, Part, SimpleTable } from "../detail/parts";
import type { KubeObject } from "../objects";
import type { DetailProps } from "../registry";
import {
  csrConditions,
  describeRequest,
  durationText,
  subjectText,
} from "./csr";

const listText = (value: unknown): string | undefined =>
  Array.isArray(value) && value.length > 0
    ? value.map(String).join(", ")
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const timeText = (value: string): string =>
  value === "" ? "" : new Date(value).toLocaleString();

/** What the request asks for, read by the core; null until it answers, or if it cannot. */
function useRequestInfo(object: KubeObject): CertificateRequestInfo | null {
  const request = text(object.spec?.request) ?? "";
  const certificate = text(object.status?.certificate) ?? "";
  const [info, setInfo] = useState<CertificateRequestInfo | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the two texts are what `object` is read for.
  useEffect(() => {
    let live = true;
    setInfo(null);
    if (request === "") return;
    describeRequest(object).then(
      (answer) => {
        if (live) setInfo(answer);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [request, certificate]);
  return info;
}

/** A CertificateSigningRequest (spec 2026-11-22 §5.3). */
export function CsrDetail({ object }: DetailProps) {
  const info = useRequestInfo(object);
  const spec = object.spec ?? {};
  return (
    <>
      <Part title="Certificate request">
        <Facts
          items={[
            ["Signer", text(spec.signerName)],
            ["Requestor", text(spec.username)],
            ["Requestor groups", listText(spec.groups)],
            ["Usages", listText(spec.usages)],
            ["Requested duration", durationText(spec.expirationSeconds)],
            ["Subject", info ? subjectText(info) : undefined],
            ["Key", info?.keyAlgorithm],
            [
              "Certificate expires",
              info?.notAfter
                ? new Date(info.notAfter).toLocaleString()
                : undefined,
            ],
          ]}
        />
      </Part>
      <Part title="Conditions">
        <SimpleTable
          testId="csr-conditions"
          headers={["Type", "Reason", "Message", "Updated"]}
          rows={csrConditions(object).map((c) => [
            c.type,
            c.reason,
            c.message,
            timeText(c.updated),
          ])}
          empty="No conditions."
        />
      </Part>
    </>
  );
}

/** The Approve confirm's body: what the certificate will say, and who asked. */
export function ApproveBody(props: {
  object: KubeObject;
  info: CertificateRequestInfo;
}) {
  const { object, info } = props;
  const spec = object.spec ?? {};
  const system = info.organizations.filter((o) => o.startsWith("system:"));
  return (
    <>
      <Facts
        items={[
          ["Subject", subjectText(info)],
          ["Signer", text(spec.signerName)],
          ["Requestor", text(spec.username)],
          ["Duration", durationText(spec.expirationSeconds)],
        ]}
      />
      {system.length > 0 ? (
        <p role="alert" data-testid="csr-approve-system">
          This certificate puts its holder in {system.join(", ")}. Approve only
          requests you expect.
        </p>
      ) : null}
    </>
  );
}
