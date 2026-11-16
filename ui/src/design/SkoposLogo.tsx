import { LOGO_MARK_PATH } from "./logoMark";
import styles from "./SkoposLogo.module.css";

/**
 * The app logo as the app icon draws it (assets/icon.svg): the TinyOrbit orbit mark on a
 * rounded tile, the mark two-thirds of the tile's width. Colours come from
 * SkoposLogo.module.css, never from this file.
 */
export function SkoposLogo({
  size = 48,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect className={styles.tile} width="256" height="256" rx="56" />
      <path
        className={styles.mark}
        fillRule="evenodd"
        transform="translate(32 32) scale(0.75)"
        d={LOGO_MARK_PATH}
      />
    </svg>
  );
}
