import argoBlack from "./logos/argo-icon-black.svg";
import argoWhite from "./logos/argo-icon-white.svg";
import helmColor from "./logos/helm-icon-color.svg";
import helmWhite from "./logos/helm-icon-white.svg";
import styles from "./ProjectLogo.module.css";

export type ProjectLogoName = "helm" | "argo";

/** The CNCF artwork of each project, unchanged: one file per theme (see THIRD_PARTY_NOTICES.md). */
const FILES: Record<ProjectLogoName, { light: string; dark: string }> = {
  helm: { light: helmColor, dark: helmWhite },
  argo: { light: argoBlack, dark: argoWhite },
};

/**
 * The logo of a project the app works with, beside its sidebar section. It only names
 * the project, so it is hidden from assistive technology: the section's label says it.
 */
export function ProjectLogo(props: {
  name: ProjectLogoName;
  size: number;
  className?: string;
}) {
  const { name, size, className } = props;
  const files = FILES[name];
  return (
    <span
      aria-hidden="true"
      data-logo={name}
      className={[styles.logo, className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
    >
      <img src={files.light} alt="" className={styles.light} />
      <img src={files.dark} alt="" className={styles.dark} />
    </span>
  );
}
